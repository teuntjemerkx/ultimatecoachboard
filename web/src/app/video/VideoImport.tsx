import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { V3 } from "../../core/spatial";
import { CourtCalibration, type CalibrationResult, type ImagePoint } from "../../core/video";
import { persist } from "../store/db";
import { useNav } from "../store/nav";
import { netHeight, useSettings } from "../store/settings";
import { Bar } from "../ui/Bar";
import { Icon } from "../ui/Icon";
import { grabFrame, openClip, type Clip } from "./clip";
import { buildRally, loadDetector } from "./pipeline";
import { deleteVideo, listVideos, saveVideo, type StoredVideo } from "./videoStore";
import "./video.css";

type Step = { name: "choose" } | { name: "mark" } | { name: "building" } | { name: "failed"; message: string };

interface Corner {
  label: "US" | "THEM";
  ours: boolean;
  point: ImagePoint;
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

/** Starting dots in a typical end-line view: their end line narrow and high, ours wide and low. */
function defaultCorners(w: number, h: number): Corner[] {
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
  const [progress, setProgress] = useState({ fraction: 0, stage: "" });
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
    const ours = corners.filter((c) => c.ours).map((c) => c.point), theirs = corners.filter((c) => !c.ours).map((c) => c.point);
    return CourtCalibration.solveCorners(ours, theirs, clip.width, clip.height);
  }, [clip, corners]);
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

  /** The still for marking the court: the clip at `at` seconds. */
  const grabStill = async (c: Clip, at: number) => {
    stillRef.current = await grabFrame(c, at, stillRef.current ?? undefined);
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
      await grabStill(c, 0.2);
      setCorners(defaultCorners(c.width, c.height));
      setStep({ name: "mark" });
      // Start loading the models while the coach marks the court.
      void loadDetector().catch(() => undefined);
    } catch (e) {
      setStep({ name: "failed", message: `That video could not be opened${e instanceof Error && e.message ? `: ${e.message}` : "."}` });
    } finally {
      setLoading(false);
    }
  };

  // A new start time shows the still there (after the slider rests briefly).
  useEffect(() => {
    if (!clip || step.name !== "mark") return;
    const timer = setTimeout(() => { void grabStill(clip, start + 0.2); }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const build = async () => {
    if (!clip || !file || !calibration) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ fraction: 0, stage: "Finding players" });
    setStep({ name: "building" });
    try {
      const result = await buildRally({
        clip, start, end, camera: calibration.camera, netHeight: net, women, title: videoTitle(), signal: ctrl.signal,
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
      if (e instanceof DOMException && e.name === "AbortError") { setStep({ name: "mark" }); return; }
      setStep({ name: "failed", message: `Building the 3D rally failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      abortRef.current = null;
    }
  };

  const stepIndex = step.name === "choose" ? 0 : step.name === "mark" ? 1 : 2;

  return (
    <div className="screen video-screen">
      <Bar title="Video to 3D">
        <div className="video-steps" aria-label={`Step ${stepIndex + 1} of 3`}>
          {[0, 1, 2].map((i) => <span key={i} className={i === stepIndex ? "now" : i < stepIndex ? "done" : ""} />)}
        </div>
      </Bar>
      {step.name === "choose" && <ChooseStep loading={loading} onFile={(f) => void choose(f)} />}
      {step.name === "mark" && clip && (
        <div className="video-mark">
          <div className="video-mark-head">
            <strong>Drag the dots onto the court's four corners</strong>
            <span className="muted">Put US on the two corners of your end line and THEM on theirs. The court lines show how well it fits.</span>
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
            <button className="btn primary" disabled={!canBuild} onClick={() => void build()}><Icon name="cube" /> Build 3D</button>
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
          <button className="btn secondary" onClick={() => setStep(clip ? { name: "mark" } : { name: "choose" })}>Try again</button>
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
    <div className="scroll">
      <div className="page stack video-choose">
        <div className="hero video-hero">
          <Icon name="video" size={44} className="video-hero-icon" />
          <h2 className="title">Turn a rally video into 3D</h2>
          <p className="subtitle">Then watch it from any player's eyes, in the hall from your video.</p>
          <div className="row">
            <button className="btn primary" disabled={loading} onClick={() => input.current?.click()}>
              <Icon name="upload" /> {loading ? "Opening the video…" : "Choose a video"}
            </button>
          </div>
          <input ref={input} type="file" accept="video/*" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onFile(f);
          }} />
        </div>
        {saved.length > 0 && (
          <section>
            <h3 className="group-title">Your videos</h3>
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
                  <button className={`btn quiet small${confirm === v.id ? " danger" : ""}`} onClick={() => void remove(v.id)}
                          aria-label={confirm === v.id ? "Tap again to delete" : `Delete ${v.title}`}>
                    <Icon name="trash" />{confirm === v.id ? "Delete?" : ""}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        <div className="card video-tips">
          <span><Icon name="upload" /> Best filmed from high up, behind an end line.</span>
          <span><Icon name="timeout" /> 4 to 10 seconds: one rally.</span>
          <span><Icon name="video" /> Hold the camera still, or use a tripod.</span>
        </div>
      </div>
    </div>
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
          <button key={i} className={`video-dot ${c.ours ? "home" : "opponent"}${drag?.i === i ? " dragging" : ""}`}
                  style={{ left: `${(c.point.x / size.w) * 100}%`, top: `${(c.point.y / size.h) * 100}%` }}
                  onPointerDown={down(i)} aria-label={`${c.label} corner`}>
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
