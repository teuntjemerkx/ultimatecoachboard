import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CourtFrame } from "../../core/match/court";
import { V3 } from "../../core/spatial";
import { CourtCalibration, type CalibrationResult, type ImagePoint, type VideoScene } from "../../core/video";
import { persist } from "../store/db";
import { useNav } from "../store/nav";
import { netHeight, useSettings } from "../store/settings";
import { Bar } from "../ui/Bar";
import { Choice } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { grabFrame, openClip, SEEK_INTO_FRAME, type Clip } from "./clip";
import { buildRally, loadDetector } from "./pipeline";
import { PlayerTaps, locksOf, playersOf, type TappedPlayer } from "./PlayerTaps";
import { deleteVideo, listVideos, loadVideo, saveVideo, type StoredVideo } from "./videoStore";
import "./video.css";

type Step = { name: "choose" } | { name: "mark" } | { name: "players" } | { name: "building" } | { name: "failed"; message: string };

/** The still the coach marks the court on (and starts tapping the players on): this far into the rally, in seconds. */
const stillAt = 0.2;

/**
 * What the coach marks: the court's four corners, or our half only (our two corners and where the net meets the
 * sidelines on the floor), for a camera low behind our end line that sees their end line squeezed behind the net.
 */
type MarkView = "court" | "half";

interface Corner {
  label: "US" | "THEM" | "NET";
  ours: boolean;
  point: ImagePoint;
}

const markViewKey = "video.markView";

/** The view chosen last on this device (a camera usually stands in the same place). */
function storedMarkView(): MarkView {
  try {
    return localStorage.getItem(markViewKey) === "half" ? "half" : "court";
  } catch {
    return "court";
  }
}

/** The court's lines and the net's top edge, split into short pieces (the court as the calibrated camera sees it). */
export function courtSegments(net: number): [V3, V3][] {
  const lines: [V3, V3][] = [
    [new V3(-4.5, 0, -9), new V3(4.5, 0, -9)], [new V3(-4.5, 0, 9), new V3(4.5, 0, 9)],
    [new V3(-4.5, 0, -9), new V3(-4.5, 0, 9)], [new V3(4.5, 0, -9), new V3(4.5, 0, 9)],
    [new V3(-4.5, 0, 0), new V3(4.5, 0, 0)], [new V3(-4.5, 0, -3), new V3(4.5, 0, -3)], [new V3(-4.5, 0, 3), new V3(4.5, 0, 3)],
    [new V3(-4.5, net, 0), new V3(4.5, net, 0)], [new V3(-4.5, 0, 0), new V3(-4.5, net, 0)], [new V3(4.5, 0, 0), new V3(4.5, net, 0)],
  ];
  return lines.flatMap(([a, b]) => Array.from({ length: 6 }, (_, k): [V3, V3] =>
    [a.add(b.sub(a).mul(k / 6)), a.add(b.sub(a).mul((k + 1) / 6))]));
}

/**
 * Starting dots in a typical end-line view: their end line narrow and high, ours wide and low; for our half, the net
 * across the middle and our corners near the bottom.
 */
function defaultCorners(w: number, h: number, view: MarkView = "court"): Corner[] {
  if (view === "half") {
    return [
      { label: "NET", ours: false, point: { x: w * 0.2, y: h * 0.7 } },
      { label: "NET", ours: false, point: { x: w * 0.8, y: h * 0.7 } },
      { label: "US", ours: true, point: { x: w * 0.95, y: h * 0.93 } },
      { label: "US", ours: true, point: { x: w * 0.05, y: h * 0.93 } },
    ];
  }
  return [
    { label: "THEM", ours: false, point: { x: w * 0.36, y: h * 0.3 } },
    { label: "THEM", ours: false, point: { x: w * 0.64, y: h * 0.3 } },
    { label: "US", ours: true, point: { x: w * 0.92, y: h * 0.86 } },
    { label: "US", ours: true, point: { x: w * 0.08, y: h * 0.86 } },
  ];
}

function videoTitle(d = new Date()): string {
  return `Video ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Video to 3D (Section 4): choose a clip, drag four dots onto the court corners, tap the players to follow, and the
 * app builds a 3D rally from the video with on-device models (MediaPipe in the browser). The hall in 3D is painted
 * from the clip itself. With `fix`, a rebuilt video opens at its players again (its clip, camera and taps), to put a
 * lost player right and build it anew.
 */
export function VideoImport({ fix }: { fix?: { videoId: string; time?: number } } = {}) {
  const go = useNav((s) => s.go);
  const women = useSettings((s) => s.women);
  const [step, setStep] = useState<Step>({ name: "choose" });
  const [loading, setLoading] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [start, setStart] = useState(0);
  const [corners, setCorners] = useState<Corner[]>([]);
  const [view, setView] = useState<MarkView>(storedMarkView);
  const [progress, setProgress] = useState({ fraction: 0, stage: "" });
  const [players, setPlayers] = useState<TappedPlayer[] | undefined>();
  const [fixing, setFixing] = useState<{ videoId: string; scene: VideoScene; title: string; time?: number } | null>(null);
  const [stillVersion, setStillVersion] = useState(0);
  const stillRef = useRef<HTMLCanvasElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const clipRef = useRef<Clip | null>(null);
  clipRef.current = clip;

  useEffect(() => () => { abortRef.current?.abort(); clipRef.current?.close(); }, []);

  const net = netHeight(women);
  const size = clip ? { w: clip.width, h: clip.height } : { w: 1, h: 1 };
  const calibration: CalibrationResult | undefined = useMemo(() => {
    if (!clip || corners.length !== 4) return undefined;
    const ours = corners.filter((c) => c.ours).map((c) => c.point), others = corners.filter((c) => !c.ours).map((c) => c.point);
    return view === "half"
      ? CourtCalibration.solveNearHalf(ours, others, "home", clip.width, clip.height)
      : CourtCalibration.solveCorners(ours, others, clip.width, clip.height);
  }, [clip, corners, view]);
  const fit = calibration?.quality === "good" ? "good" : calibration?.quality === "rough" ? "rough" : "unknown";
  const canBuild = calibration !== undefined && fit !== "unknown";
  const camera = fixing?.scene.camera ?? calibration?.camera;
  const courtLines = useMemo(() => {
    if (!calibration) return [];
    const cam = calibration.camera;
    return courtSegments(net).flatMap(([a, b]) => {
      const pa = cam.project(a), pb = cam.project(b);
      return pa && pb ? [[pa, pb] as const] : [];
    });
  }, [calibration, net]);
  const end = clip ? Math.min(clip.duration, start + 10) : 0;

  /** The still for marking the court: the clip at `at` seconds, read as a build reads that time. */
  const grabStill = async (c: Clip, at: number) => {
    stillRef.current = await grabFrame(c, at + SEEK_INTO_FRAME, stillRef.current ?? undefined);
    setStillVersion((v) => v + 1);
  };

  const choose = async (f: File) => {
    setLoading(true);
    try {
      clip?.close();
      const c = await openClip(f);
      if (c.duration < 1) {
        c.close();
        setStep({ name: "failed", message: "That video is too short. Choose a clip of 4 to 10 seconds." });
        return;
      }
      setFile(f);
      setClip(c);
      setStart(0);
      await grabStill(c, stillAt);
      setCorners(defaultCorners(c.width, c.height, view));
      setStep({ name: "mark" });
      // Start loading the models while the coach marks the court.
      void loadDetector().catch(() => undefined);
    } catch (e) {
      setStep({ name: "failed", message: `That video could not be opened${e instanceof Error && e.message ? `: ${e.message}` : "."}` });
    } finally {
      setLoading(false);
    }
  };

  /** Switches what the coach marks; the US dots stay where they are. */
  const changeView = (v: MarkView) => {
    if (!clip || v === view) return;
    setView(v);
    try { localStorage.setItem(markViewKey, v); } catch { /* private browsing: the choice lasts this visit */ }
    const fresh = defaultCorners(clip.width, clip.height, v);
    setCorners((cs) => fresh.map((c, i) => (c.ours && cs[i]?.ours ? { ...c, point: cs[i].point } : c)));
  };

  // A new start time shows the still there (after the slider rests briefly).
  useEffect(() => {
    if (!clip || step.name !== "mark") return;
    const timer = setTimeout(() => { void grabStill(clip, start + stillAt); }, 150);
    // Taps are times in the rally: another start makes them someone else's.
    setPlayers(undefined);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  // A rebuilt video opened to put its players right: its clip, camera, start and taps.
  useEffect(() => {
    if (!fix) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const r = await loadVideo(fix.videoId);
        if (!r?.stored.clip) throw new Error("its clip is not on this iPad");
        const f = new File([r.stored.clip], r.scene.videoFile ?? "rally.mp4", { type: r.stored.clip.type || "video/mp4" });
        const c = await openClip(f);
        if (!alive) { c.close(); return; }
        setFile(f);
        setClip(c);
        setStart(r.scene.clipStart ?? 0);
        setPlayers(playersOf(r.stored.locks ?? [], r.scene.camera));
        setFixing({ videoId: fix.videoId, scene: r.scene, title: r.stored.title, time: fix.time });
        setStep({ name: "players" });
        void loadDetector().catch(() => undefined);
      } catch (e) {
        if (alive) setStep({ name: "failed", message: `That video could not be opened${e instanceof Error && e.message ? `: ${e.message}` : "."}` });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix?.videoId]);

  /** On to tapping the players (the first time those inside the lines are picked). */
  const toPlayers = () => {
    if (!calibration) return;
    setStep({ name: "players" });
  };

  const build = async () => {
    if (!clip || !file || !camera) return;
    const locks = locksOf(players ?? []);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ fraction: 0, stage: "Finding players" });
    setStep({ name: "building" });
    try {
      const result = await buildRally({
        clip, start, end, camera, netHeight: net, women, title: fixing?.title ?? videoTitle(), signal: ctrl.signal, locks,
        onProgress: (fraction, stage) => setProgress({ fraction, stage }),
      });
      console.info(`Video to 3D: ${calibration ? `calibration ${calibration.quality} rms ${calibration.rmsError.toFixed(2)} px` : "camera kept"}; ${result.report}`);
      if (result.scene.players.length === 0) {
        setStep({ name: "failed", message: "No players were found. Try a clip where the whole court is in view." });
        return;
      }
      result.scene.videoFile = file.name;
      await saveVideo(result.scene, file, result.plate, locks);
      // A rebuilt video replaces the one it put right.
      if (fixing) await deleteVideo(fixing.videoId);
      void persist();
      go({ name: "watch", videoId: result.scene.id });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") { setStep({ name: "players" }); return; }
      setStep({ name: "failed", message: `Building the 3D rally failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      abortRef.current = null;
    }
  };

  const stepIndex = step.name === "choose" ? 0 : step.name === "mark" ? 1 : step.name === "players" ? 2 : 3;

  return (
    <div className="screen video-screen">
      <Bar title="Video to 3D">
        <div className="video-steps" aria-label={`Step ${stepIndex + 1} of 4`}>
          {[0, 1, 2, 3].map((i) => <span key={i} className={i === stepIndex ? "now" : i < stepIndex ? "done" : ""} />)}
        </div>
      </Bar>
      {step.name === "choose" && <ChooseStep loading={loading} onFile={(f) => void choose(f)} />}
      {step.name === "mark" && clip && (
        <div className="video-mark">
          <div className="video-mark-head">
            <Choice label="What the video shows" value={view} onChange={changeView}
                    options={[{ value: "court", title: "Whole court" }, { value: "half", title: "Our half" }]} />
            {view === "court" ? (
              <>
                <strong>Drag the dots onto the court's four corners</strong>
                <span className="muted">Put US on the two corners of your end line and THEM on theirs. The court lines show how well it fits.</span>
              </>
            ) : (
              <>
                <strong>Drag the dots onto your half</strong>
                <span className="muted">Put US on the two corners of your end line and NET where the net meets each sideline on the floor, straight below the antenna. For a camera low behind your end line.</span>
              </>
            )}
          </div>
          <MarkStill still={stillRef.current} version={stillVersion} size={size} corners={corners} lines={courtLines}
                     onMove={(i, p) => setCorners((cs) => cs.map((c, k) => (k === i ? { ...c, point: p } : c)))} />
          <div className="video-mark-foot">
            <span className={`video-badge ${fit}`}>
              <Icon name={fit === "good" ? "check" : fit === "rough" ? "timeout" : "target"} />
              {fit === "good" ? "Good fit" : fit === "rough" ? "Rough fit: move the dots closer to the corners" : "The dots don't make a court yet"}
            </span>
            <span className="spacer" />
            {clip.duration > 10.5 && (
              <label className="video-start">
                <span>Start at {start.toFixed(1)} s</span>
                <input type="range" min={0} max={Math.max(0, clip.duration - 4)} step={0.1} value={start}
                       onChange={(e) => setStart(Number(e.target.value))} />
              </label>
            )}
            <button className="btn quiet" onClick={() => { clip.close(); setClip(null); setStep({ name: "choose" }); }}>Other video</button>
            <button className="btn primary" disabled={!canBuild} onClick={() => void toPlayers()}>Next <Icon name="chevronRight" /></button>
          </div>
        </div>
      )}
      {step.name === "players" && clip && camera && (
        <PlayerTaps clip={clip} start={start} length={end - start} camera={camera} players={players} onPlayers={setPlayers}
                    scene={fixing?.scene} initialTime={fixing?.time}
                    onBack={fixing ? () => go({ name: "watch", videoId: fixing.videoId }) : () => setStep({ name: "mark" })}
                    backLabel={fixing ? "3D" : "Court"} onBuild={() => void build()} />
      )}
      {step.name === "building" && (
        <div className="empty video-building">
          <div className="video-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
            <span style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
          <strong className="video-stage-name">{progress.stage}</strong>
          <span>This runs on your iPad. Nothing leaves the device.</span>
          <button className="btn secondary" onClick={() => abortRef.current?.abort()}>Stop</button>
        </div>
      )}
      {step.name === "failed" && (
        <div className="empty">
          <Icon name="close" size={44} className="video-fault" />
          <strong>{step.message}</strong>
          <button className="btn secondary" onClick={() => setStep(!clip ? { name: "choose" } : camera ? { name: "players" } : { name: "mark" })}>Try again</button>
        </div>
      )}
    </div>
  );
}

function ChooseStep({ loading, onFile }: { loading: boolean; onFile: (f: File) => void }) {
  const go = useNav((s) => s.go);
  const [saved, setSaved] = useState<(StoredVideo & { thumb?: string })[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    void listVideos().then((items) => {
      if (!alive) return;
      setSaved(items.map((v) => {
        const thumb = v.plate ? URL.createObjectURL(v.plate) : undefined;
        if (thumb) urls.push(thumb);
        return { ...v, thumb };
      }));
    }).catch(() => undefined);
    return () => { alive = false; for (const u of urls) URL.revokeObjectURL(u); };
  }, []);

  const remove = async (id: string) => {
    if (confirm !== id) { setConfirm(id); return; }
    await deleteVideo(id);
    setSaved((s) => s.filter((v) => v.id !== id));
    setConfirm(null);
  };

  return (
    <main className="fill video-fill">
      <section className="locker-card">
        <div className="plate-head"><span className="plate"><Icon name="video" size={20} /> New rally</span></div>
        <div className="card-body video-hero">
          <Icon name="video" size={72} className="locker-icon" />
          <h2 className="title">Turn a rally video into 3D</h2>
          <p className="subtitle">Then watch it from any player's eyes, in the hall from your video.</p>
          <div className="video-tips">
            <span><Icon name="upload" /> Best filmed from high up, behind an end line.</span>
            <span><Icon name="timeout" /> 4 to 10 seconds: one rally.</span>
            <span><Icon name="video" /> Hold the camera still, or use a tripod.</span>
          </div>
          <button className="btn primary wide" style={{ marginTop: "auto" }} disabled={loading} onClick={() => input.current?.click()}>
            <Icon name="upload" /> {loading ? "Opening the video…" : "Choose a video"}
          </button>
          <input ref={input} type="file" accept="video/*" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onFile(f);
          }} />
        </div>
      </section>
      <section className="locker-card">
        <div className="plate-head"><span className="plate"><Icon name="film" size={20} /> Your videos</span><span className="aside">{saved.length}</span></div>
        <div className="card-body">
          {saved.length === 0 ? (
            <div className="empty" style={{ flex: 1 }}>Your rebuilt rallies appear here, ready to watch again.</div>
          ) : (
            <div className="video-saved">
              {saved.map((v) => (
                <div key={v.id} className="video-saved-item">
                  <button className="video-saved-open" onClick={() => go({ name: "watch", videoId: v.id })}>
                    {v.thumb ? <img src={v.thumb} alt="" /> : <span className="video-saved-blank"><Icon name="cube" /></span>}
                    <span className="video-saved-text">
                      <strong>{v.title}</strong>
                      <span className="muted">{v.duration.toFixed(0)} s · {v.scene.players.length} players{v.clip ? "" : " · no clip"}</span>
                    </span>
                    <Icon name="chevronRight" />
                  </button>
                  <button className={`btn quiet${confirm === v.id ? " danger" : ""}`} onClick={() => void remove(v.id)}
                          aria-label={confirm === v.id ? "Tap again to delete" : `Delete ${v.title}`}>
                    <Icon name="trash" />{confirm === v.id ? "Delete?" : ""}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

/** The still with the court overlay and the four dots; a 3x loupe above the finger while a dot is dragged. */
function MarkStill({ still, version, size, corners, lines, onMove }: {
  still: HTMLCanvasElement | null;
  version: number;
  size: { w: number; h: number };
  corners: Corner[];
  lines: readonly (readonly [ImagePoint, ImagePoint])[];
  onMove: (i: number, p: ImagePoint) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ i: number; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !still) return;
    c.width = still.width;
    c.height = still.height;
    c.getContext("2d")!.drawImage(still, 0, 0);
  }, [still, version]);

  const s = Math.min(box.w / size.w, box.h / size.h) || 0;
  const fit = { w: size.w * s, h: size.h * s, x: (box.w - size.w * s) / 2, y: (box.h - size.h * s) / 2 };

  // The loupe: 150 points across, three times the still's displayed scale.
  useEffect(() => {
    const l = loupeRef.current, src = canvasRef.current;
    if (!drag || !l || !src || !(s > 0)) return;
    const px = 150, ratio = window.devicePixelRatio || 1;
    l.width = px * ratio;
    l.height = px * ratio;
    const g = l.getContext("2d")!;
    const span = px / (s * 3);
    const p = corners[drag.i].point;
    g.fillStyle = "#000";
    g.fillRect(0, 0, l.width, l.height);
    g.drawImage(src, p.x - span / 2, p.y - span / 2, span, span, 0, 0, l.width, l.height);
  }, [drag, corners, s]);

  const toImage = (clientX: number, clientY: number): ImagePoint => {
    const r = boxRef.current!.getBoundingClientRect();
    const x = (clientX - r.left - fit.x) / fit.w, y = (clientY - r.top - fit.y) / fit.h;
    return { x: Math.min(Math.max(0, x), 1) * size.w, y: Math.min(Math.max(0, y), 1) * size.h };
  };

  const down = (i: number) => (e: ReactPointerEvent) => {
    e.preventDefault();
    try { boxRef.current?.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    const r = boxRef.current!.getBoundingClientRect();
    setDrag({ i, x: e.clientX - r.left, y: e.clientY - r.top });
    onMove(i, toImage(e.clientX, e.clientY));
  };
  const move = (e: ReactPointerEvent) => {
    if (!drag) return;
    const r = boxRef.current!.getBoundingClientRect();
    setDrag({ i: drag.i, x: e.clientX - r.left, y: e.clientY - r.top });
    onMove(drag.i, toImage(e.clientX, e.clientY));
  };
  const up = () => setDrag(null);

  return (
    <div className="video-still-box" ref={boxRef} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="video-still" style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}>
        <canvas ref={canvasRef} />
        <svg viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" aria-hidden="true">
          {lines.map(([a, b], k) => <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />)}
        </svg>
        {corners.map((c, i) => (
          <button key={i} className={`video-dot ${c.ours ? "home" : c.label === "NET" ? "net" : "opponent"}${drag?.i === i ? " dragging" : ""}`}
                  style={{ left: `${(c.point.x / size.w) * 100}%`, top: `${(c.point.y / size.h) * 100}%` }}
                  onPointerDown={down(i)} aria-label={c.label === "NET" ? "NET point" : `${c.label} corner`}>
            <span className="video-dot-label">{c.label}</span>
          </button>
        ))}
      </div>
      {drag && (
        <div className="video-loupe" style={{ left: Math.min(Math.max(drag.x, 90), box.w - 90), top: Math.max(drag.y - 120, 80) }}>
          <canvas ref={loupeRef} />
          <span>+</span>
        </div>
      )}
    </div>
  );
}
