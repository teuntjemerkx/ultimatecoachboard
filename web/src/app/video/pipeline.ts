import {
  PersonDetection, VideoScene, type ImagePoint, type Keypoints, type VideoCamera, type VideoFrameObservation,
} from "../../core/video";
import { grabFrame, type Clip } from "./clip";
import { Detector, type FrameDetections } from "./detect";
import type { RebuildReply, RebuildRequest } from "./rebuild.worker";

/** The MediaPipe models, loaded once per session (about 20 MB, cached for offline use). */
let detector: Promise<Detector> | undefined;

export function loadDetector(): Promise<Detector> {
  detector ??= Detector.load(import.meta.env.BASE_URL).catch((e: unknown) => {
    detector = undefined;
    throw e;
  });
  return detector;
}

export interface BuildResult {
  scene: VideoScene;
  plate?: Blob;
  /** What the build found, for diagnostics. */
  report: string;
}

export class BuildError extends Error {}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
}

type Person = FrameDetections["people"][number];

/**
 * The mean jersey colour of a person (r, g, b in 0...1): the torso between the shoulders and the hips, or the upper
 * middle of the box without them. The tracker uses it to keep players apart where they nearly meet (at the net).
 */
export function jerseyColour(p: Person, pixels: Uint8ClampedArray, width: number, height: number): number[] | undefined {
  const k = p.keypoints;
  const pts = [k.leftShoulder, k.rightShoulder, k.leftHip, k.rightHip];
  let x0: number, x1: number, y0: number, y1: number;
  if (pts.every((q) => q && q.confidence > 0.3)) {
    const xs = pts.map((q) => q!.x);
    const top = (k.leftShoulder!.y + k.rightShoulder!.y) / 2, bottom = (k.leftHip!.y + k.rightHip!.y) / 2;
    const left = Math.min(...xs), right = Math.max(...xs);
    x0 = left + 0.2 * (right - left);
    x1 = right - 0.2 * (right - left);
    y0 = top + 0.15 * (bottom - top);
    y1 = top + 0.7 * (bottom - top);
  } else {
    x0 = p.box.x + 0.3 * p.box.w;
    x1 = p.box.x + 0.7 * p.box.w;
    y0 = p.box.y + 0.22 * p.box.h;
    y1 = p.box.y + 0.45 * p.box.h;
  }
  if (!(x1 - x0 >= 2 && y1 - y0 >= 2)) return undefined;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const x = Math.round(x0 + ((x1 - x0) * (i + 0.5)) / 8), y = Math.round(y0 + ((y1 - y0) * (j + 0.5)) / 8);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const o = (y * width + x) * 4;
      r += pixels[o];
      g += pixels[o + 1];
      b += pixels[o + 2];
      n += 1;
    }
  }
  return n > 0 ? [r / n / 255, g / n / 255, b / n / 255] : undefined;
}

/** People in a detector frame as the core's detections, standing where their feet meet the floor. */
export function observation(time: number, d: FrameDetections, camera: VideoCamera, ball?: ImagePoint,
  appearance?: readonly (number[] | undefined)[]): VideoFrameObservation {
  const detections: PersonDetection[] = [];
  for (const [i, p] of d.people.entries()) {
    const kp: Keypoints = {};
    for (const [name, k] of Object.entries(p.keypoints) as [keyof Keypoints, { x: number; y: number; confidence: number }][]) {
      if (k.confidence > 0.1) kp[name] = { point: { x: k.x, y: k.y }, confidence: k.confidence };
    }
    const det = PersonDetection.fromKeypoints(kp, p.score, camera, {
      boxHeight: p.box.h, boxBottom: { x: p.box.x + p.box.w / 2, y: p.box.y + p.box.h }, appearance: appearance?.[i],
    });
    if (det) detections.push(det);
  }
  return ball ? { time, detections, ball } : { time, detections };
}

type BallCandidates = FrameDetections["balls"];

/**
 * The ball candidates without the ones that stay put: about the same pixel in at least four frames spread over a
 * second or more (an antenna top, a logo, a spare ball by the bench, a ball held before the serve). The detector
 * finds those in most frames, often above the ball in flight.
 */
export function withoutFixtures(frames: readonly { time: number; balls: BallCandidates }[], width: number): BallCandidates[] {
  const r = Math.max(2, 0.006 * width);
  const grid = new Map<string, { frame: number; time: number; x: number; y: number }[]>();
  frames.forEach((f, frame) => {
    for (const b of f.balls) {
      const key = `${Math.floor(b.x / r)},${Math.floor(b.y / r)}`;
      const cell = grid.get(key) ?? [];
      cell.push({ frame, time: f.time, x: b.x, y: b.y });
      grid.set(key, cell);
    }
  });
  const fixed = (b: { x: number; y: number }) => {
    const cx = Math.floor(b.x / r), cy = Math.floor(b.y / r);
    const seen = new Set<number>();
    let t0 = Infinity, t1 = -Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const a of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.hypot(a.x - b.x, a.y - b.y) > r) continue;
          seen.add(a.frame);
          t0 = Math.min(t0, a.time);
          t1 = Math.max(t1, a.time);
        }
      }
    }
    return seen.size >= 4 && t1 - t0 >= 1;
  };
  return frames.map((f) => f.balls.filter((b) => !fixed(b)));
}

/**
 * One ball pixel per frame (in time order) from the detector's candidates, best first. Candidates that stay put are
 * left out (`withoutFixtures`). While the ball was seen less than 0.5 s ago, the candidate nearest to where its path
 * leads is taken, also a weak one (down to the detector's threshold), so a stronger stray elsewhere (a second ball,
 * a light, a head) does not break the flight; otherwise the best candidate scoring 0.2 or more.
 */
export function pickBalls(frames: readonly { time: number; balls: BallCandidates }[], width: number): (ImagePoint | undefined)[] {
  const moving = withoutFixtures(frames, width);
  const path: { t: number; p: ImagePoint }[] = [];
  return frames.map((f, i) => {
    const candidates = moving[i];
    let choice = candidates.find((b) => b.score >= 0.2);
    const last = path[path.length - 1], before = path[path.length - 2];
    if (last && f.time - last.t < 0.5) {
      // Carried on at its last speed in the image (from two picks less than 0.3 s apart), else where it was.
      const k = before && last.t - before.t < 0.3 ? (f.time - last.t) / (last.t - before.t) : 0;
      const at = before && k > 0 ? { x: last.p.x + k * (last.p.x - before.p.x), y: last.p.y + k * (last.p.y - before.p.y) } : last.p;
      const dist = (b: { x: number; y: number }) => Math.hypot(b.x - at.x, b.y - at.y);
      const reach = width * (0.04 + 0.8 * (f.time - last.t));
      const near = candidates.filter((b) => dist(b) <= reach).sort((a, b) => dist(a) - dist(b))[0];
      if (near) choice = near;
    }
    if (!choice) return undefined;
    path.push({ t: f.time, p: { x: choice.x, y: choice.y } });
    return { x: choice.x, y: choice.y };
  });
}

/**
 * The frames a build reads over [start, end]: pose frames at `rate` per second (people, pose and the ball) and, in
 * each gap between two of them, `between` frames for the ball alone, evenly spaced. In time order.
 */
export function samplePlan(start: number, end: number, rate = 10, between = 2): { time: number; pose: boolean }[] {
  const count = Math.max(2, Math.round((end - start) * rate) + 1);
  const plan: { time: number; pose: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + ((end - start) * i) / (count - 1);
    plan.push({ time: t, pose: true });
    if (i === count - 1) break;
    const next = start + ((end - start) * (i + 1)) / (count - 1);
    for (let k = 1; k <= between; k++) plan.push({ time: t + ((next - t) * k) / (between + 1), pose: false });
  }
  return plan;
}

/**
 * Whether two small copies of frames show the same picture: a clip with fewer frames per second than are sampled
 * (an old camera, a 25 fps export, a GIF) gives the same frame for several times. A new frame always differs by more
 * than sensor and compression noise somewhere.
 */
export function sameFrame(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 3 || Math.abs(a[i + 1] - b[i + 1]) > 3 || Math.abs(a[i + 2] - b[i + 2]) > 3) differ += 1;
  }
  return differ <= 2;
}

/** A worker job: posts the request and resolves with its final reply (progress replies go to `onProgress`). */
function runWorker(request: RebuildRequest, transfer: Transferable[], signal: AbortSignal | undefined,
  onProgress?: (fraction: number, stage: string) => void): Promise<RebuildReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./rebuild.worker.ts", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      reject(new DOMException("Stopped", "AbortError"));
    };
    signal?.addEventListener("abort", stop, { once: true });
    worker.onmessage = (e: MessageEvent<RebuildReply>) => {
      const r = e.data;
      if (r.kind === "progress") { onProgress?.(r.fraction, r.stage); return; }
      signal?.removeEventListener("abort", stop);
      worker.terminate();
      if (r.kind === "error") reject(new BuildError(r.message));
      else resolve(r);
    };
    worker.onerror = (e) => {
      signal?.removeEventListener("abort", stop);
      worker.terminate();
      reject(new BuildError(e.message || "The rebuild stopped unexpectedly."));
    };
    worker.postMessage(request, transfer);
  });
}

async function plateBlob(pixels: Uint8Array, width: number, height: number): Promise<Blob | undefined> {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length), width, height), 0, 0);
  return new Promise((resolve) => c.toBlob((b) => resolve(b ?? undefined), "image/jpeg", 0.9));
}

/** Frames read for the ball alone between two pose frames (30 frames a second in all). */
const BALL_FRAMES_BETWEEN = 2;
/** The time a ball-only frame takes against a pose frame (the object detector without the pose model), for progress. */
const BALL_FRAME_COST = 0.3;

/**
 * Video to 3D (Section 4) for a clip and a calibrated camera (for frames of the clip's working size): people and the
 * ball on frames sampled at 10 per second, the ball alone on two more frames between each two of them (repeated
 * frames of a clip with fewer frames per second are skipped), the clean plate of the hall from about 24 pose frames
 * with the people masked, then the reconstruction in a worker.
 */
export async function buildRally(options: {
  clip: Clip; start: number; end: number; camera: VideoCamera; netHeight: number; women: boolean; title: string;
  onProgress: (fraction: number, stage: string) => void; signal?: AbortSignal;
}): Promise<BuildResult> {
  const { clip, start, end, camera, signal, onProgress } = options;
  onProgress(0, "Loading the player detector");
  const det = await loadDetector();
  aborted(signal);

  const plan = samplePlan(start, end, 10, BALL_FRAMES_BETWEEN);
  const count = plan.filter((s) => s.pose).length;
  const plateCount = Math.min(24, count);
  const plateEvery = count / plateCount;
  const pw = Math.min(960, clip.width), ph = Math.round((pw * clip.height) / clip.width);
  // Only people standing near the court get the pose model; the stands and the benches keep their boxes.
  const nearCourt = (box: { x: number; y: number; w: number; h: number }) => {
    const p = camera.floorPoint({ x: box.x + box.w / 2, y: box.y + box.h });
    return p !== undefined && Math.abs(p.x) <= 7.5 && Math.abs(p.z) <= 12.5;
  };
  const work = document.createElement("canvas");
  const small = document.createElement("canvas");
  small.width = pw;
  small.height = ph;
  const sg = small.getContext("2d", { willReadFrequently: true })!;
  // A small copy of each frame read, to skip a frame that repeats the one before.
  const print = document.createElement("canvas");
  print.width = Math.min(480, clip.width);
  print.height = Math.max(1, Math.round((print.width * clip.height) / clip.width));
  const prg = print.getContext("2d", { willReadFrequently: true })!;
  let previous: Uint8ClampedArray | undefined;
  const sampled: { time: number; detections: FrameDetections; appearance: (number[] | undefined)[]; repeat: boolean }[] = [];
  const ballOnly: { time: number; balls: BallCandidates }[] = [];
  let repeats = 0;
  const plateFrames: Uint8Array[] = [], plateMasks: Uint8Array[] = [];
  let nextPlate = 0;
  const total = plan.reduce((n, s) => n + (s.pose ? 1 : BALL_FRAME_COST), 0);
  let done = 0;
  for (const s of plan) {
    aborted(signal);
    await grabFrame(clip, s.time, work);
    prg.drawImage(work, 0, 0, print.width, print.height);
    const fingerprint = prg.getImageData(0, 0, print.width, print.height).data;
    const repeat = previous !== undefined && sameFrame(fingerprint, previous);
    previous = fingerprint;
    if (repeat) repeats += 1;
    done += s.pose ? 1 : BALL_FRAME_COST;
    if (!s.pose) {
      // The ball alone; a repeated frame adds nothing (its ball was seen at the earlier time).
      if (!repeat) ballOnly.push({ time: s.time - start, balls: det.detectBalls(work, clip.width, clip.height) });
      onProgress(0.04 + (0.56 * done) / total, "Finding players and the ball");
      await tick();
      continue;
    }
    const i = sampled.length;
    const d = det.detect(work, clip.width, clip.height, nearCourt);
    const pixels = work.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, clip.width, clip.height).data;
    sampled.push({ time: s.time - start, detections: d, repeat,
      appearance: d.people.map((p) => jerseyColour(p, pixels, clip.width, clip.height)) });
    if (i >= nextPlate && plateFrames.length < plateCount) {
      nextPlate += plateEvery;
      sg.drawImage(work, 0, 0, pw, ph);
      plateFrames.push(new Uint8Array(sg.getImageData(0, 0, pw, ph).data.buffer));
      // Where people are, grown a little so edges and shadows stay out of the plate.
      const mask = new Uint8Array(pw * ph);
      const s = pw / clip.width;
      for (const p of d.people) {
        const grow = 4 + 0.08 * p.box.h * s;
        const x0 = Math.max(0, Math.floor(p.box.x * s - grow)), x1 = Math.min(pw, Math.ceil((p.box.x + p.box.w) * s + grow));
        const y0 = Math.max(0, Math.floor(p.box.y * s - grow)), y1 = Math.min(ph, Math.ceil((p.box.y + p.box.h) * s + grow));
        for (let y = y0; y < y1; y++) mask.fill(1, y * pw + x0, y * pw + x1);
      }
      plateMasks.push(mask);
    }
    onProgress(0.04 + (0.56 * done) / total, "Finding players and the ball");
    await tick();
  }

  onProgress(0.62, "Building the hall");
  const plateReply = await runWorker({ kind: "plate", frames: plateFrames, masks: plateMasks, width: pw, height: ph },
    [...plateFrames.map((f) => f.buffer), ...plateMasks.map((m) => m.buffer)], signal);
  const plate = plateReply.kind === "plate" ? await plateBlob(plateReply.pixels, pw, ph) : undefined;
  aborted(signal);

  // The ball over all frames read, in time order (a repeated pose frame keeps its people but not the ball).
  const frames = [
    ...sampled.map((f, k) => ({ time: f.time, pose: k, balls: f.repeat ? [] : f.detections.balls })),
    ...ballOnly.map((f) => ({ time: f.time, pose: -1, balls: f.balls })),
  ].sort((a, b) => a.time - b.time);
  const balls = pickBalls(frames, clip.width);
  const ballAt = new Map<number, ImagePoint>();
  const observations: VideoFrameObservation[] = [];
  frames.forEach((f, k) => {
    const ball = balls[k];
    if (f.pose >= 0) {
      if (ball) ballAt.set(f.pose, ball);
    } else if (ball) {
      observations.push({ time: f.time, detections: [], ball });
    }
  });
  observations.push(...sampled.map((f, k) => observation(f.time, f.detections, camera, ballAt.get(k), f.appearance)));
  observations.sort((a, b) => a.time - b.time);
  if (import.meta.env.DEV) (globalThis as { __videoDebug?: unknown }).__videoDebug = { observations, camera: camera.encode() };
  const people = sampled.map((f) => f.detections.people.length), posed = sampled.map((f) =>
    f.detections.people.filter((p) => Object.keys(p.keypoints).length > 0).length);
  let report = `${count} frames and ${ballOnly.length} for the ball alone (${repeats} repeated frames skipped), `
    + `people per frame ${Math.min(...people)}-${Math.max(...people)} (with pose ${Math.min(...posed)}-${Math.max(...posed)}), `
    + `detections ${observations.reduce((n, o) => n + o.detections.length, 0)}, ball points ${balls.filter(Boolean).length}; `
    + `camera ${camera.center.y.toFixed(1)} m up, ${camera.center.z.toFixed(1)} m back, fovY ${((camera.fovY * 180) / Math.PI).toFixed(1)} deg`;

  onProgress(0.7, "Tracking players");
  const reply = await runWorker({ kind: "reconstruct", frames: observations, camera: camera.encode(), netHeight: options.netHeight,
    women: options.women, title: options.title }, [], signal, (f, stage) => onProgress(0.7 + 0.3 * f, stage));
  if (reply.kind !== "scene") throw new BuildError("The rebuild did not finish.");
  const scene = VideoScene.decode(reply.scene);
  scene.clipStart = start;
  scene.plateFile = plate ? "plate.jpg" : undefined;
  report += `; rebuilt ${scene.players.length} players (${scene.players.filter((p) => p.side === "home").length} home, `
    + `${scene.players.filter((p) => p.side === "opponent").length} away), ${scene.ball.length} ball flights over ${scene.duration.toFixed(1)} s`;
  return { scene, plate, report };
}
