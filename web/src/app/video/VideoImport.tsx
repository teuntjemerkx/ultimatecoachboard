import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CourtFrame } from "../../core/match/court";
import { V3 } from "../../core/spatial";
import {
  CourtCalibration, type CalibrationResult, type ImagePoint, type PersonDetection, type TrackLock, type VideoCamera,
} from "../../core/video";
import { persist } from "../store/db";
import { useNav } from "../store/nav";
import { netHeight, useSettings } from "../store/settings";
import { Bar } from "../ui/Bar";
import { Choice } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { grabFrame, openClip, SEEK_INTO_FRAME, type Clip } from "./clip";
import { buildRally, loadDetector, peopleOnStill } from "./pipeline";
import { deleteVideo, listVideos, saveVideo, type StoredVideo } from "./videoStore";
import "./video.css";

type Step = { name: "choose" } | { name: "mark" } | { name: "players" } | { name: "building" } | { name: "failed"; message: string };

/** The still the coach marks the court and taps the players on: this far into the rally, in seconds. */
const stillAt = 0.2;

/** The people found on the still and the players the coach picked: found people by index, and feet tapped by hand. */
interface Picks {
  people: { detection: PersonDetection; box: { x: number; y: number; w: number; h: number } }[];
  finding: boolean;
  failed: boolean;
  picked: Set<number>;
  extra: ImagePoint[];
}

const noPicks: Picks = { people: [], finding: false, failed: false, picked: new Set(), extra: [] };

/**
 * Standing inside the court's lines (15 cm of slack for the feet): a player, picked from the start. A coach at the
 * sideline stands just outside and is left for the coach to tap, if anyone.
 */
const insideLines = (p: { x: number; z: number }) => Math.abs(p.x) <= CourtFrame.halfWidth + 0.15 && Math.abs(p.z) <= 9.15;

/**
 * The people picked from the start: those inside the lines, best detection first. Left out: a box much shorter than
 * a person standing there (legs or a torso the detector boxed apart), and a second box the detector put on someone
 * already picked (mostly inside theirs, standing on about the same spot); a player farther back, seen behind
 * someone, stays.
 */
function preselect(people: Picks["people"], camera: VideoCamera): Set<number> {
  const picked: number[] = [];
  type Box = Picks["people"][number]["box"];
  const overlap = (a: Box, b: Box) => {
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (w * h) / Math.min(a.w * a.h, b.w * b.h);
  };
  /** How tall someone of 1.75 m stands at a floor point in the picture, pixels. */
  const tall = (p: { x: number; z: number }) => {
    const feet = camera.project(V3.fromFloor(p, 0)), head = camera.project(V3.fromFloor(p, 1.75));
    return feet && head ? feet.y - head.y : 0;
  };
  people.forEach((p, i) => {
    const f = p.detection.floor;
    if (!insideLines(f) || p.box.h < 0.55 * tall(f)) return;
    const twin = picked.some((j) => {
      const g = people[j].detection.floor;
      return overlap(people[j].box, p.box) > 0.6 && Math.hypot(f.x - g.x, f.z - g.z) < 1.2;
    });
    if (!twin) picked.push(i);
  });
  return new Set(picked);
}

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
 * Video to 3D (Section 4): choose a clip, drag four dots onto the court corners, and the app builds a 3D rally from
 * the video with on-device models (MediaPipe in the browser). The hall in 3D is painted from the clip itself.
 */
export function VideoImport() {
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
  const [picks, setPicks] = useState<Picks>(noPicks);
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
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  /** On to tapping the players: the people on the still, those inside the lines picked. */
  const toPlayers = async () => {
    const still = stillRef.current;
    if (!calibration || !still) return;
    setStep({ name: "players" });
    setPicks({ ...noPicks, finding: true });
    try {
      const people = await peopleOnStill(still, calibration.camera);
      setPicks({ ...noPicks, people, picked: preselect(people, calibration.camera) });
    } catch {
      setPicks({ ...noPicks, failed: true });
    }
  };

  const locks: TrackLock[] = [
    ...[...picks.picked].map((i) => ({ time: stillAt, foot: picks.people[i].detection.footImage })),
    ...picks.extra.map((foot) => ({ time: stillAt, foot })),
  ];

  const build = async () => {
    if (!clip || !file || !calibration) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ fraction: 0, stage: "Finding players" });
    setStep({ name: "building" });
    try {
      const result = await buildRally({
        clip, start, end, camera: calibration.camera, netHeight: net, women, title: videoTitle(), signal: ctrl.signal, locks,
        onProgress: (fraction, stage) => setProgress({ fraction, stage }),
      });
      console.info(`Video to 3D: calibration ${calibration.quality} rms ${calibration.rmsError.toFixed(2)} px; ${result.report}`);
      if (result.scene.players.length === 0) {
        setStep({ name: "failed", message: "No players were found. Try a clip where the whole court is in view." });
        return;
      }
      result.scene.videoFile = file.name;
      await saveVideo(result.scene, file, result.plate);
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
      {step.name === "players" && clip && calibration && (
        <div className="video-mark">
          <div className="video-mark-head">
            <strong>Tap the players to follow</strong>
            <span className="muted">Only the players you pick are rebuilt. Those inside the lines are picked already: tap someone to add or drop them. No box around a player? Tap their feet.</span>
          </div>
          <PlayerStill still={stillRef.current} version={stillVersion} size={size} camera={calibration.camera} picks={picks}
                       onChange={setPicks} />
          <div className="video-mark-foot">
            <span className="video-badge good"><Icon name="target" /> {pickedText(locks, calibration.camera)}</span>
            <span className="spacer" />
            <button className="btn quiet" onClick={() => setStep({ name: "mark" })}><Icon name="chevronLeft" /> Court</button>
            <button className="btn quiet" disabled={picks.finding || picks.people.length === 0}
                    onClick={() => setPicks((p) => ({ ...p, picked: preselect(p.people, calibration.camera) }))}>
              All on court
            </button>
            <button className="btn quiet" disabled={locks.length === 0} onClick={() => setPicks((p) => ({ ...p, picked: new Set(), extra: [] }))}>None</button>
            <button className="btn primary" disabled={picks.finding} onClick={() => void build()}><Icon name="cube" /> Build 3D</button>
          </div>
        </div>
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
          <button className="btn secondary" onClick={() => setStep(!clip ? { name: "choose" } : calibration ? { name: "players" } : { name: "mark" })}>Try again</button>
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

/** "Following 11: 6 ours, 5 theirs", or what a build does without any. */
function pickedText(locks: readonly TrackLock[], camera: VideoCamera): string {
  if (locks.length === 0) return "No one picked: the players are found automatically";
  const ours = locks.filter((l) => {
    const p = camera.floorPoint(l.foot);
    return p !== undefined && CourtFrame.side(p) === "home";
  }).length;
  return `Following ${locks.length}: ${ours} ours, ${locks.length - ours} theirs`;
}

/**
 * The still with a box around everyone the detector found: picked ones in their team's colour, the others dashed.
 * A tap on a box picks or drops that person; a tap on the court where there is no box adds a player standing there
 * (the tap is their feet), and a tap on such a player drops them again.
 */
function PlayerStill({ still, version, size, camera, picks, onChange }: {
  still: HTMLCanvasElement | null;
  version: number;
  size: { w: number; h: number };
  camera: VideoCamera;
  picks: Picks;
  onChange: (p: Picks) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

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

  /** At least this wide on screen, so a far player is a target a finger can hit. */
  const wide = (b: { x: number; y: number; w: number; h: number }) => {
    const w = Math.max(b.w, 22 / Math.max(s, 1e-3));
    return { ...b, x: b.x + (b.w - w) / 2, w };
  };
  /** A player tapped by hand: feet at the tap, as tall as someone of 1.85 m stands there in the picture. */
  const tapped = (foot: ImagePoint) => {
    const floor = camera.floorPoint(foot);
    const head = floor ? camera.project(V3.fromFloor(floor, 1.85)) : undefined;
    const h = head ? Math.max(8, foot.y - head.y) : 40;
    return wide({ x: foot.x - 0.2 * h, y: foot.y - h, w: 0.4 * h, h });
  };
  const people = picks.people.map((p) => wide(p.box));
  const extras = picks.extra.map(tapped);
  const sideOf = (foot: ImagePoint) => {
    const p = camera.floorPoint(foot);
    return p ? CourtFrame.side(p) : "home";
  };

  const tap = (e: ReactPointerEvent) => {
    if (picks.finding || !(s > 0)) return;
    const r = boxRef.current!.getBoundingClientRect();
    const p = { x: (e.clientX - r.left - fit.x) / s, y: (e.clientY - r.top - fit.y) / s };
    if (p.x < 0 || p.y < 0 || p.x > size.w || p.y > size.h) return;
    // A box under the finger (a few points of slack); of several, the one whose middle is nearest.
    const slack = 10 / s;
    const hit = (b: { x: number; y: number; w: number; h: number }) =>
      p.x >= b.x - slack && p.x <= b.x + b.w + slack && p.y >= b.y - slack && p.y <= b.y + b.h + slack
        ? Math.abs(p.x - (b.x + b.w / 2)) / b.w + Math.abs(p.y - (b.y + b.h / 2)) / b.h : Infinity;
    const best = [...people.map((b, i) => ({ kind: "person" as const, i, d: hit(b) })), ...extras.map((b, i) => ({ kind: "extra" as const, i, d: hit(b) }))]
      .filter((c) => c.d < Infinity).sort((a, b) => a.d - b.d)[0];
    if (best?.kind === "person") {
      const picked = new Set(picks.picked);
      if (picked.has(best.i)) picked.delete(best.i); else picked.add(best.i);
      onChange({ ...picks, picked });
    } else if (best?.kind === "extra") {
      onChange({ ...picks, extra: picks.extra.filter((_, i) => i !== best.i) });
    } else {
      const floor = camera.floorPoint(p);
      if (floor && Math.abs(floor.x) <= CourtFrame.halfWidth + 2 && Math.abs(floor.z) <= 11) onChange({ ...picks, extra: [...picks.extra, p] });
    }
  };

  return (
    <div className="video-still-box" ref={boxRef} onPointerUp={tap}>
      <div className="video-still" style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}>
        <canvas ref={canvasRef} />
        <svg viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" aria-hidden="true" className="video-people">
          {people.map((b, i) => (
            <rect key={`p${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(b.w / 2, 8 / Math.max(s, 1e-3))}
                  className={picks.picked.has(i) ? `picked ${sideOf(picks.people[i].detection.footImage)}` : "free"} vectorEffect="non-scaling-stroke" />
          ))}
          {extras.map((b, i) => (
            <rect key={`e${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(b.w / 2, 8 / Math.max(s, 1e-3))}
                  className={`picked tapped ${sideOf(picks.extra[i])}`} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      </div>
      {picks.finding && <div className="video-finding">Finding the players…</div>}
      {picks.failed && <div className="video-finding">No one found on this frame. Tap the players' feet, or build without.</div>}
    </div>
  );
}
