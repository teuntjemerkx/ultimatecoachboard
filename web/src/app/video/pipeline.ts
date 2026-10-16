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

/**
 * One ball pixel per frame from the detector's candidates: the best one, unless a weaker one continues the path of
 * the frames before much better (a second ball in the stands, a light, a head).
 */
export function pickBalls(frames: readonly { time: number; balls: FrameDetections["balls"] }[], width: number): (ImagePoint | undefined)[] {
  let last: { t: number; p: ImagePoint } | undefined;
  return frames.map((f) => {
    const candidates = f.balls.filter((b) => b.score >= 0.2);
    if (candidates.length === 0) return undefined;
    let choice = candidates[0];
    if (last && f.time - last.t < 0.5) {
      const from = last.p;
      const dist = (b: { x: number; y: number }) => Math.hypot(b.x - from.x, b.y - from.y);
      const reach = width * (0.04 + 0.8 * (f.time - last.t));
      const near = candidates.filter((b) => dist(b) <= reach).sort((a, b) => dist(a) - dist(b))[0];
      if (near && dist(choice) > reach) choice = near;
    }
    last = { t: f.time, p: { x: choice.x, y: choice.y } };
    return { x: choice.x, y: choice.y };
  });
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

/**
 * Video to 3D (Section 4) for a clip and a calibrated camera (for frames of the clip's working size): people and the
 * ball on frames sampled at 10 per second, the clean plate of the hall from about 24 of them with the people masked,
 * then the reconstruction in a worker.
 */
export async function buildRally(options: {
  clip: Clip; start: number; end: number; camera: VideoCamera; netHeight: number; women: boolean; title: string;
  onProgress: (fraction: number, stage: string) => void; signal?: AbortSignal;
}): Promise<BuildResult> {
  const { clip, start, end, camera, signal, onProgress } = options;
  onProgress(0, "Loading the player detector");
  const det = await loadDetector();
  aborted(signal);

  const rate = 10;
  const count = Math.max(2, Math.round((end - start) * rate) + 1);
  const times = Array.from({ length: count }, (_, i) => start + ((end - start) * i) / (count - 1));
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
  const sampled: { time: number; detections: FrameDetections; appearance: (number[] | undefined)[] }[] = [];
  const plateFrames: Uint8Array[] = [], plateMasks: Uint8Array[] = [];
  let nextPlate = 0;
  for (let i = 0; i < count; i++) {
    aborted(signal);
    await grabFrame(clip, times[i], work);
    const d = det.detect(work, clip.width, clip.height, nearCourt);
    const pixels = work.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, clip.width, clip.height).data;
    sampled.push({ time: times[i] - start, detections: d,
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
    onProgress(0.04 + (0.56 * (i + 1)) / count, "Finding players");
    await tick();
  }

  onProgress(0.62, "Building the hall");
  const plateReply = await runWorker({ kind: "plate", frames: plateFrames, masks: plateMasks, width: pw, height: ph },
    [...plateFrames.map((f) => f.buffer), ...plateMasks.map((m) => m.buffer)], signal);
  const plate = plateReply.kind === "plate" ? await plateBlob(plateReply.pixels, pw, ph) : undefined;
  aborted(signal);

  const balls = pickBalls(sampled.map((f) => ({ time: f.time, balls: f.detections.balls })), clip.width);
  const observations = sampled.map((f, i) => observation(f.time, f.detections, camera, balls[i], f.appearance));
  if (import.meta.env.DEV) (globalThis as { __videoDebug?: unknown }).__videoDebug = { observations, camera: camera.encode() };
  const people = sampled.map((f) => f.detections.people.length), posed = sampled.map((f) =>
    f.detections.people.filter((p) => Object.keys(p.keypoints).length > 0).length);
  let report = `${count} frames, people per frame ${Math.min(...people)}-${Math.max(...people)} (with pose ${Math.min(...posed)}-${Math.max(...posed)}), `
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
