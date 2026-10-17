import { BallFlight, V3 } from "../../core/spatial";
import {
  PersonDetection, VideoScene, type ImagePoint, type Keypoints, type TrackLock, type VideoCamera, type VideoFrameObservation,
} from "../../core/video";
import { grabFrame, type Clip } from "./clip";
import { Detector, zoomTiles, type BallCandidate, type FrameDetections, type ZoomBand } from "./detect";
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

/**
 * People in a detector frame as the core's detections, standing where their feet meet the floor. The pose model reads
 * a crop around each person's box, and on a far, small player it now and then puts joints on a neighbour or on the
 * floor beside them, metres away on the court: a keypoint outside the person's box (with a little room) is left out,
 * and the feet are read from joints the model is fairly sure of (0.3), else from the bottom of the box.
 */
export function observation(time: number, d: FrameDetections, camera: VideoCamera, ball?: BallPick,
  appearance?: readonly (number[] | undefined)[]): VideoFrameObservation {
  const detections: PersonDetection[] = [];
  for (const [i, p] of d.people.entries()) {
    const kp: Keypoints = {};
    const mx = 0.25 * p.box.w, my = 0.08 * p.box.h;
    for (const [name, k] of Object.entries(p.keypoints) as [keyof Keypoints, { x: number; y: number; confidence: number }][]) {
      const inBox = k.x >= p.box.x - mx && k.x <= p.box.x + p.box.w + mx && k.y >= p.box.y - my && k.y <= p.box.y + p.box.h + my;
      if (k.confidence > 0.1 && inBox) kp[name] = { point: { x: k.x, y: k.y }, confidence: k.confidence };
    }
    const det = PersonDetection.fromKeypoints(kp, p.score, camera, {
      boxHeight: p.box.h, boxBottom: { x: p.box.x + p.box.w / 2, y: p.box.y + p.box.h }, appearance: appearance?.[i], minConfidence: 0.3,
    });
    if (det) detections.push(det);
  }
  return ball ? { time, detections, ...ballObservation(ball) } : { time, detections };
}

type BallCandidates = FrameDetections["balls"];

/** The ball picked in a frame: its pixel, and its diameter when the detector's box was whole. */
export type BallPick = ImagePoint & { size?: number };

/** A picked ball as the fields of a frame observation. */
function ballObservation(b: BallPick): Pick<VideoFrameObservation, "ball" | "ballSize"> {
  return b.size !== undefined ? { ball: { x: b.x, y: b.y }, ballSize: b.size } : { ball: { x: b.x, y: b.y } };
}

/**
 * The ball candidates without the ones that stay put: about the same pixel in at least four frames spread over a
 * second or more (an antenna top, a logo, a spare ball by the bench, a ball held before the serve), or in five frames
 * or more over 0.2 s or longer without a break of 0.1 s (the head or a knee pad of a player standing still: the ball
 * in flight leaves its pixel within a few frames, even at the top of a set). The detector finds those in most frames,
 * often above the ball in flight. On the Orion clip a far player's head stood at one pixel for about a second (just
 * over on the read times, just under on the frame grid), and was then picked as the ball for 0.7 s instead of the
 * start of the attack off our block. Candidates found by following the ball (`zoomed`) count only against each other:
 * a far ball that hardly moves in the picture, seen in a few more frames that way, would read as a head standing still
 * (on the OK Hoče clip 572 to 577 px over 0.2 s at 8.1 s), while a path followed onto something that stays put (a
 * shoe at 3.1 s on the recording of that clip) is left out as before.
 */
export function withoutFixtures(frames: readonly { time: number; balls: BallCandidates }[], width: number): BallCandidates[] {
  const r = Math.max(2, 0.006 * width);
  const grid = new Map<string, { frame: number; time: number; x: number; y: number; zoomed?: boolean }[]>();
  frames.forEach((f, frame) => {
    for (const b of f.balls) {
      const key = `${Math.floor(b.x / r)},${Math.floor(b.y / r)}`;
      const cell = grid.get(key) ?? [];
      cell.push({ frame, time: f.time, x: b.x, y: b.y, zoomed: b.zoomed });
      grid.set(key, cell);
    }
  });
  const fixed = (b: BallCandidate, time: number) => {
    const cx = Math.floor(b.x / r), cy = Math.floor(b.y / r);
    const seen = new Map<number, number>();
    let t0 = Infinity, t1 = -Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const a of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.hypot(a.x - b.x, a.y - b.y) > r || (a.zoomed && !b.zoomed)) continue;
          seen.set(a.frame, a.time);
          t0 = Math.min(t0, a.time);
          t1 = Math.max(t1, a.time);
        }
      }
    }
    if (seen.size >= 4 && t1 - t0 >= 1) return true;
    // The unbroken run of frames around this one.
    const times = [...seen.values()].sort((a, c) => a - c);
    let lo = times.indexOf(time), hi = lo;
    while (lo > 0 && times[lo] - times[lo - 1] <= 0.1) lo -= 1;
    while (hi >= 0 && hi < times.length - 1 && times[hi + 1] - times[hi] <= 0.1) hi += 1;
    return lo >= 0 && hi - lo + 1 >= 5 && times[hi] - times[lo] >= 0.2;
  };
  return frames.map((f) => f.balls.filter((b) => !fixed(b, f.time)));
}

/**
 * One ball pixel per frame (in time order) from the detector's candidates, best first. Candidates that stay put are
 * left out (`withoutFixtures`). While the ball was seen less than 0.5 s ago, the candidate nearest to where its path
 * leads is taken, also a weak one (down to the detector's threshold), so a stronger stray elsewhere (a second ball, a
 * light, a head) does not break the flight; otherwise the best candidate scoring 0.2 or more. One found by following
 * the path in a zoomed tile (`followBall`) is taken only where no candidate scores 0.2 or more: it can be any object
 * of the ball's size (on the OK Hoče clip a knee where a spare ball's path ended took the first point of the serve's
 * toss, and the toss was no flight).
 */
export function pickBalls(frames: readonly { time: number; balls: BallCandidates }[], width: number): (BallPick | undefined)[] {
  const moving = withoutFixtures(frames, width);
  const path = new BallPath(width);
  return frames.map((f, i) => {
    const b = path.pick(f.time, moving[i]);
    if (!b) return undefined;
    return b.size !== undefined ? { x: b.x, y: b.y, size: b.size } : { x: b.x, y: b.y };
  });
}

/** The ball's path through the frames as `pickBalls` follows it: its picks since the last pick off the path. */
class BallPath {
  readonly picks: { t: number; b: BallCandidate }[] = [];

  constructor(private readonly width: number) {}

  /**
   * Where the path leads at t, and how far from there the ball may be, while it was seen less than 0.5 s ago: carried
   * on at its last speed in the image (from two picks less than 0.3 s apart), else where it was.
   */
  lead(t: number): { at: ImagePoint; reach: number } | undefined {
    const last = this.picks[this.picks.length - 1], before = this.picks[this.picks.length - 2];
    if (!last || t - last.t >= 0.5) return undefined;
    const k = before && last.t - before.t < 0.3 ? (t - last.t) / (last.t - before.t) : 0;
    const at = before && k > 0 ? { x: last.b.x + k * (last.b.x - before.b.x), y: last.b.y + k * (last.b.y - before.b.y) } : last.b;
    return { at, reach: this.width * (0.04 + 0.8 * (t - last.t)) };
  }

  /** The candidate taken in a frame at t (see `pickBalls`), added to the path. */
  pick(t: number, candidates: BallCandidates): BallCandidate | undefined {
    let choice = candidates.find((b) => b.score >= 0.2 && !b.zoomed);
    const lead = this.lead(t);
    let onPath = false;
    if (lead) {
      const dist = (b: ImagePoint) => Math.hypot(b.x - lead.at.x, b.y - lead.at.y);
      const near = candidates.filter((b) => dist(b) <= lead.reach).sort((a, b) => dist(a) - dist(b))[0];
      // A zoomed candidate (an object of any class) gives way to a ball the detector sees elsewhere.
      if (near && !(near.zoomed && choice)) {
        choice = near;
        onPath = true;
      }
    }
    if (!choice) return undefined;
    // A pick off the path starts a new one: its speed is not the jump from the old path.
    if (!onPath) this.picks.length = 0;
    this.picks.push({ t, b: choice });
    return choice;
  }
}

/** An object of any class in a zoomed tile (`Detector.objectsIn`), frame pixels. */
export interface TileObject { box: { x: number; y: number; w: number; h: number }; score: number }

/** One look along the ball's path (`followBall`): the frame, where the path led, how far off the ball could be, the tile. */
export interface BallLook {
  frame: number; at: ImagePoint; reach: number; tile: { x: number; y: number; side: number };
  /** The object taken as the ball, with its box's smaller side. */
  found?: ImagePoint & { box: number };
}

/** Picks within 0.3 s on a path before it is followed into zoomed tiles. */
const FOLLOW_PICKS = 4;
/** How far from the camera (by its size in the picture) a ball must be to be followed, metres. */
const FOLLOW_FAR = 15;
/** Looks in a row without the ball after which a path is no longer followed. */
const FOLLOW_MISSES = 3;
/** How long a path is followed past its last pick by the detector itself (not a zoomed one), seconds. */
const FOLLOW_SPAN = 1;

/**
 * The ball where the detector loses it far away. On the OK Hoče clip the serve over their court (11 px, against the
 * wall band and the banners) is no sports ball to the detector even zoomed in (its ball score there is 0.003 to 0.06,
 * no higher than elsewhere in the tile), but it still boxes it, as a person, a clock or a bird. So where a moving path
 * (`FOLLOW_PICKS` picks in its last 0.3 s, a ball's width apart or more) of a ball at least `FOLLOW_FAR` from the
 * camera (by the median of its last five widths) leads inside the frame and no candidate is within 0.8 ball widths of
 * that point, `look` reads the frame again in a square tile around it (12 ball widths, 128 to 256 px). The object of
 * any class nearest to the point, as wide as the ball (its smaller side 0.6 to 1.5 times the width, its longer side at
 * most 1.8 times) and within that distance, joins the frame's candidates as `zoomed`: no score, so it carries the path
 * on and never starts one, and no size (its box is about 1.4 times the ball). Where the path leads is a least-squares
 * parabola in time through those picks (a line through fewer than five): the far ball's image speeds up as it drops.
 * The distance allowed grows by half for each look in a row without the ball; following stops after `FOLLOW_MISSES`
 * of those or `FOLLOW_SPAN` after the path's last pick by the detector itself. Repeated frames are skipped. Returns
 * the looks.
 *
 * Only a far ball: it hardly moves in the picture between frames, and where its path leads is good to a few pixels
 * (the Hoče serve is lost 24 m away). On the Orion clip the detector misses the attack off the block for three frames
 * 7 m away, as it comes at the camera and speeds up in the picture; the path led up to 45 px behind it, ball-sized
 * objects there were taken, and the flight came out at 6 m/s instead of 17.
 */
export async function followBall(frames: readonly { time: number; balls: BallCandidates; repeat?: boolean }[], camera: VideoCamera,
  look: (frame: number, tile: { x: number; y: number; side: number }) => Promise<TileObject[]>): Promise<BallLook[]> {
  const { width, height } = camera;
  const moving = withoutFixtures(frames, width);
  const path = new BallPath(width);
  const boxes = new WeakMap<BallCandidate, number>();
  const looks: BallLook[] = [];
  let misses = 0;
  const dist = (a: ImagePoint, b: ImagePoint) => Math.hypot(a.x - b.x, a.y - b.y);
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    if (f.repeat) continue;
    const picks = path.picks, last = picks[picks.length - 1];
    const recent = last ? picks.filter((q) => last.t - q.t <= 0.3 + 1e-9) : [];
    const own = [...picks].reverse().find((q) => !q.b.zoomed);
    const sizes = picks.slice(-5).flatMap((q) => q.b.size ?? boxes.get(q.b) ?? []).sort((a, b) => a - b);
    const size = sizes[Math.floor(sizes.length / 2)];
    if (size !== undefined && (camera.focalLength * 2 * BallFlight.radius) / size >= FOLLOW_FAR
      && recent.length >= FOLLOW_PICKS && dist(recent[0].b, last.b) >= size && own && f.time - own.t <= FOLLOW_SPAN
      && misses < FOLLOW_MISSES) {
      const at = curveAt(recent, f.time);
      const reach = 0.8 * size * (1 + 0.5 * misses);
      if (at.x >= 0 && at.x < width && at.y >= 0 && at.y < height && !moving[k].some((b) => dist(b, at) <= reach)) {
        const side = Math.round(Math.min(width, height, 256, Math.max(128, 12 * size)));
        const tile = { x: Math.round(Math.max(0, Math.min(width - side, at.x - side / 2))),
          y: Math.round(Math.max(0, Math.min(height - side, at.y - side / 2))), side };
        const best = (await look(k, tile))
          .map(({ box }) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2, small: Math.min(box.w, box.h), large: Math.max(box.w, box.h) }))
          .filter((o) => dist(o, at) <= reach && o.small >= 0.6 * size && o.small <= 1.5 * size && o.large <= 1.8 * size)
          .sort((a, b) => dist(a, at) - dist(b, at))[0];
        looks.push({ frame: k, at, reach, tile, ...(best ? { found: { x: best.x, y: best.y, box: best.small } } : {}) });
        if (best) {
          const ball: BallCandidate = { x: best.x, y: best.y, score: 0, zoomed: true };
          boxes.set(ball, best.small);
          f.balls.push(ball);
          moving[k].push(ball);
        } else {
          misses += 1;
        }
      }
    }
    if (path.pick(f.time, moving[k])) misses = 0;
  }
  return looks;
}

/** Where a least-squares curve in time through the picks (a parabola through five or more, else a line) is at t. */
function curveAt(picks: readonly { t: number; b: ImagePoint }[], t: number): ImagePoint {
  const t0 = picks[picks.length - 1].t, n = picks.length >= 5 ? 3 : 2;
  const at = (value: (p: ImagePoint) => number) => {
    // The normal equations of the polynomial in u = t - t0, solved by elimination.
    const m = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
    for (const q of picks) {
      const u = q.t - t0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) m[i][j] += u ** (i + j);
        m[i][n] += u ** i * value(q.b);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = m[r][i] / m[i][i];
        for (let c = i; c <= n; c++) m[r][c] -= f * m[i][c];
      }
    }
    const u = t - t0;
    return m.reduce((sum, row, i) => sum + (row[n] / row[i]) * u ** i, 0);
  };
  return { x: at((p) => p.x), y: at((p) => p.y) };
}

/** Whether a person's box stands near the court: only they get the pose model (the stands and the benches keep their box). */
export function standsNearCourt(camera: VideoCamera) {
  return (box: { x: number; y: number; w: number; h: number }) => {
    const p = camera.floorPoint({ x: box.x + box.w / 2, y: box.y + box.h });
    return p !== undefined && Math.abs(p.x) <= 7.5 && Math.abs(p.z) <= 12.5;
  };
}

/**
 * The court around the net and their half, which the detector reads again zoomed (`ZoomBand`): their half from 0.5 m
 * on our side of the net to 3 m behind their end line, 0.5 m past the sidelines, from the floor to 2.4 m, and down to
 * the floor 3 m into our half, so our players at the net stand whole in the zoomed tiles too. A box found there counts
 * when it is upright and at least 0.7 of the height of a person standing at its foot (not legs alone or a group;
 * from a camera at head height a box cut at the hips still passes, its foot lands where people look that small).
 * Undefined when that part of the court is not in view, or its tiles would not be much smaller than the main ones
 * (0.6 of the frame's width): from a camera high at the side, their half is large in the picture already.
 */
export function farCourtBand(camera: VideoCamera, balls = false): ZoomBand | undefined {
  const xs: number[] = [], ys: number[] = [];
  for (const x of [-5, 5]) {
    for (const z of [0.5, -12]) {
      for (const y of [0, 2.4]) {
        const p = camera.project(new V3(x, y, z));
        if (!p) return undefined;
        xs.push(p.x);
        ys.push(p.y);
      }
    }
  }
  const near = camera.project(new V3(0, 0, 3));
  if (!near) return undefined;
  const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(camera.width, Math.max(...xs));
  const y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(camera.height, Math.max(near.y + 8, ...ys));
  if (!(x1 - x0 > 8 && y1 - y0 > 8)) return undefined;
  const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (zoomTiles(rect, camera.width, camera.height)[0].side > 0.4 * camera.width) return undefined;
  const whole = (box: { x: number; y: number; w: number; h: number }) => {
    const f = camera.floorPoint({ x: box.x + box.w / 2, y: box.y + box.h });
    if (!f) return false;
    const feet = camera.project(V3.fromFloor(f, 0)), head = camera.project(V3.fromFloor(f, 1.75));
    return feet !== undefined && head !== undefined && box.h >= 0.7 * (feet.y - head.y) && box.h >= 1.4 * box.w;
  };
  return { ...rect, whole, balls };
}

/**
 * The people on one frame (the still the coach taps the players on), found as a build finds them, so a tap on one
 * of them is the detection the build sees in that frame.
 */
export async function peopleOnStill(still: HTMLCanvasElement, camera: VideoCamera):
  Promise<{ detection: PersonDetection; box: { x: number; y: number; w: number; h: number } }[]> {
  const det = await loadDetector();
  const found = det.detect(still, still.width, still.height, standsNearCourt(camera), farCourtBand(camera));
  return found.people.flatMap((p) => {
    const [detection] = observation(0, { people: [p], balls: [] }, camera).detections;
    return detection ? [{ detection, box: p.box }] : [];
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
 * (an old camera, a 25 fps export, a GIF) gives the same frame for several times. A repeat is identical, or after a
 * re-encode (a 25 fps clip saved at 30) differs by compression noise of a few levels; a new frame differs by more than
 * 8 levels in about one pixel in a hundred or more (the players move), so the line is drawn at one in two thousand.
 */
export function sameFrame(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  const limit = a.length / 4 / 2000;
  let differ = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) {
      differ += 1;
      if (differ > limit) return false;
    }
  }
  return true;
}

/** Frame rates a clip with fewer frames than a build reads is likely to have (film, PAL and NTSC video). */
const CLIP_RATES = [23.976, 24, 25, 29.97];

/**
 * The frame grid of a clip with fewer frames a second than a build reads, from which reads repeated the frame before
 * (`sameFrame`): its rate and phase, so that the read at clip time t shows frame floor(t * fps - phase), which a seek
 * shows from (frame + phase) / fps on. A 24 fps clip read every 33 ms repeats a frame every fifth read and is read up
 * to 33 ms after its frame came up, so the read times step 33 ms where the frames step 42 ms, and a ball coming at
 * the camera seems to slow down and speed up. The rate and phase that predict the repeats best, when they predict all
 * but a few (a still picture repeats too; compression noise can hide a repeat); undefined when the reads hardly
 * repeat (the clip has as many frames as are read, or more) or no common rate fits.
 */
export function frameGrid(reads: readonly { time: number; repeat: boolean }[]): { fps: number; phase: number } | undefined {
  const repeats = reads.filter((r, i) => i > 0 && r.repeat).length;
  if (reads.length < 10 || repeats < 3) return undefined;
  let best: { fps: number; phase: number; misses: number } | undefined;
  for (const fps of CLIP_RATES) {
    // Phases in steps of 1/200 of a frame; the middle of the best run of them (a run can wrap around 1).
    const misses = Array.from({ length: 200 }, (_, k) => {
      const phase = k / 200;
      const frame = (t: number) => Math.floor(t * fps - phase + 1e-9);
      let n = 0;
      for (let i = 1; i < reads.length; i++) if ((frame(reads[i].time) === frame(reads[i - 1].time)) !== reads[i].repeat) n += 1;
      return n;
    });
    const least = Math.min(...misses);
    if (best && least >= best.misses) continue;
    let run = { start: 0, length: 0 };
    for (let k = 0; k < 200; k++) {
      let length = 0;
      while (length < 200 && misses[(k + length) % 200] === least) length += 1;
      if (length > run.length) run = { start: k, length };
    }
    best = { fps, phase: ((run.start + (run.length - 1) / 2) / 200) % 1, misses: least };
  }
  return best && best.misses <= Math.max(2, 0.15 * repeats) ? { fps: best.fps, phase: best.phase } : undefined;
}

/** The time a read at clip time t shows a frame from, on a clip's frame grid (`frameGrid`). */
export function onFrameGrid(t: number, grid: { fps: number; phase: number }): number {
  return (Math.floor(t * grid.fps - grid.phase + 1e-9) + grid.phase) / grid.fps;
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
 * Whether the zoomed band's ball candidates count (the ball-only frames read the band only then). Off: on the Orion clip
 * they were heads, knee pads and shoes (38 ball points became 52 and 1 flight 2, both false) for 32 s more per 10 s.
 */
const ZOOM_BALLS = false;
/** Frames read for the ball alone between two pose frames (30 frames a second in all). */
const BALL_FRAMES_BETWEEN = 2;
/**
 * The time a ball-only frame takes against a pose frame (the object detector's two tiles, without the zoomed band and the
 * pose model), for progress.
 */
const BALL_FRAME_COST = 0.2;

/**
 * Video to 3D (Section 4) for a clip and a calibrated camera (for frames of the clip's working size): people and the
 * ball on frames sampled at 10 per second, the ball alone on two more frames between each two of them (repeated
 * frames of a clip with fewer frames per second are skipped), the clean plate of the hall from about 24 pose frames
 * with the people masked, then the reconstruction in a worker.
 */
export async function buildRally(options: {
  clip: Clip; start: number; end: number; camera: VideoCamera; netHeight: number; women: boolean; title: string;
  /** The players the coach tapped (times from `start`), followed through the whole clip. */
  locks?: TrackLock[];
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
  const nearCourt = standsNearCourt(camera);
  const band = farCourtBand(camera, ZOOM_BALLS);
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
  // Every read's clip time and whether it repeated the frame before, for the clip's own frame grid.
  const reads: { time: number; repeat: boolean }[] = [];
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
    reads.push({ time: s.time, repeat });
    done += s.pose ? 1 : BALL_FRAME_COST;
    if (!s.pose) {
      // The ball alone; a repeated frame adds nothing (its ball was seen at the earlier time).
      if (!repeat) ballOnly.push({ time: s.time, balls: det.detectBalls(work, clip.width, clip.height, band) });
      onProgress(0.04 + (0.56 * done) / total, "Finding players and the ball");
      await tick();
      continue;
    }
    const i = sampled.length;
    const d = det.detect(work, clip.width, clip.height, nearCourt, band);
    const pixels = work.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, clip.width, clip.height).data;
    sampled.push({ time: s.time, detections: d, repeat,
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

  // The ball at the time its frame came up in the clip (`frameGrid`), from the start of the rally: a 24 fps frame can be
  // read 33 ms after it came up, in which a spike moves a metre. The players stay at the read times (they move a few
  // centimetres in that time, and the tracker is sensitive to uneven spacing: on the Orion clip ±10 ms of jitter moves
  // the share of unseen samples between 28% and 37%, the frame grid gave 35%). A clip with as many frames as are read
  // keeps the read times, and a pose frame's ball stays with its people.
  const grid = frameGrid(reads);
  const ballTime = (t: number) => (grid ? onFrameGrid(t, grid) : t) - start;
  // The ball over all frames read, in time order (a repeated pose frame keeps its people but not the ball).
  const frames = [
    ...sampled.map((f, k) => ({ time: ballTime(f.time), read: f.time - start, pose: k, repeat: f.repeat, balls: f.repeat ? [] : f.detections.balls })),
    ...ballOnly.map((f) => ({ time: ballTime(f.time), read: f.time - start, pose: -1, repeat: false, balls: f.balls })),
  ].sort((a, b) => a.time - b.time);

  // Where the detector loses the ball in flight, the frames read again along its path, zoomed.
  onProgress(0.6, "Following the ball");
  let looks: BallLook[];
  try {
    looks = await followBall(frames, camera, async (k, tile) => {
      aborted(signal);
      await grabFrame(clip, frames[k].read + start, work);
      const objects = await det.objectsIn(work, tile);
      await tick();
      return objects;
    });
  } finally {
    await det.courtObjects();
  }
  aborted(signal);

  onProgress(0.62, "Building the hall");
  const plateReply = await runWorker({ kind: "plate", frames: plateFrames, masks: plateMasks, width: pw, height: ph },
    [...plateFrames.map((f) => f.buffer), ...plateMasks.map((m) => m.buffer)], signal);
  const plate = plateReply.kind === "plate" ? await plateBlob(plateReply.pixels, pw, ph) : undefined;
  aborted(signal);

  const balls = pickBalls(frames, clip.width);
  const ballAt = new Map<number, BallPick>();
  const observations: VideoFrameObservation[] = [];
  frames.forEach((f, k) => {
    const ball = balls[k];
    if (!ball) return;
    if (f.pose >= 0 && !grid) ballAt.set(f.pose, ball);
    else observations.push({ time: f.time, detections: [], ...ballObservation(ball) });
  });
  observations.push(...sampled.map((f, k) => observation(f.time - start, f.detections, camera, ballAt.get(k), f.appearance)));
  observations.sort((a, b) => a.time - b.time);
  if (import.meta.env.DEV) {
    (globalThis as { __videoDebug?: unknown }).__videoDebug = { observations, camera: camera.encode(), locks: options.locks, start, grid,
      reads, ballFrames: frames.map((f) => ({ time: f.time, read: f.read, balls: f.balls })), width: clip.width,
      looks: looks.map((l) => ({ ...l, time: frames[l.frame].time, read: frames[l.frame].read })) };
  }
  const people = sampled.map((f) => f.detections.people.length), posed = sampled.map((f) =>
    f.detections.people.filter((p) => Object.keys(p.keypoints).length > 0).length);
  let report = `${count} frames and ${ballOnly.length} for the ball alone (${repeats} repeated frames skipped), `
    + `people per frame ${Math.min(...people)}-${Math.max(...people)} (with pose ${Math.min(...posed)}-${Math.max(...posed)}), `
    + `detections ${observations.reduce((n, o) => n + o.detections.length, 0)}, ball points ${balls.filter(Boolean).length} `
    + `(followed in ${looks.length} zoomed tiles, the ball in ${looks.filter((l) => l.found).length}); `
    + `camera ${camera.center.y.toFixed(1)} m up, ${camera.center.z.toFixed(1)} m back, fovY ${((camera.fovY * 180) / Math.PI).toFixed(1)} deg`
    + (grid ? `; ball on a ${grid.fps} fps frame grid` : "");

  onProgress(0.7, "Tracking players");
  const reply = await runWorker({ kind: "reconstruct", frames: observations, camera: camera.encode(), netHeight: options.netHeight,
    women: options.women, title: options.title, locks: options.locks }, [], signal, (f, stage) => onProgress(0.7 + 0.3 * f, stage));
  if (reply.kind !== "scene") throw new BuildError("The rebuild did not finish.");
  const scene = VideoScene.decode(reply.scene);
  scene.clipStart = start;
  scene.plateFile = plate ? "plate.jpg" : undefined;
  report += `; rebuilt ${scene.players.length} players (${scene.players.filter((p) => p.side === "home").length} home, `
    + `${scene.players.filter((p) => p.side === "opponent").length} away, ${options.locks?.length ?? 0} tapped), `
    + `${scene.ball.length} ball flights over ${scene.duration.toFixed(1)} s`;
  return { scene, plate, report };
}
