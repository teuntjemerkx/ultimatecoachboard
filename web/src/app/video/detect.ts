import { FilesetResolver, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";

/**
 * People and the ball in one video frame with Google's MediaPipe models, running in the browser on the iPad (no
 * Apple frameworks, nothing uploaded). Two stages, as broadcast footage needs: a person detector finds everyone on a
 * tiled frame (and again, zoomed, in a band over the far court where the players are small), then the pose model reads
 * each person from a crop of their own. Pixel coordinates of the frame, origin top-left.
 */
export type BodyKeypoint =
  | "nose" | "leftEye" | "rightEye" | "leftEar" | "rightEar" | "neck"
  | "leftShoulder" | "rightShoulder" | "leftElbow" | "rightElbow" | "leftWrist" | "rightWrist"
  | "root" | "leftHip" | "rightHip" | "leftKnee" | "rightKnee" | "leftAnkle" | "rightAnkle";

export interface Keypoint { x: number; y: number; confidence: number }

export interface DetectedPerson {
  box: { x: number; y: number; w: number; h: number };
  score: number;
  keypoints: Partial<Record<BodyKeypoint, Keypoint>>;
}

export interface FrameDetections {
  people: DetectedPerson[];
  /**
   * Ball candidates, best first: the centre of the box and, when the box is whole (not cut by the frame or a tile edge),
   * its smaller side (`size`, the ball's diameter; motion blur only stretches the box along the motion).
   */
  balls: { x: number; y: number; score: number; size?: number }[];
}

/**
 * A band of the frame the detector reads again, zoomed (the far court around the net, where players are small), and
 * which of the people found there count: a box in a zoomed tile can be a torso or legs of someone the tile cuts off.
 */
export interface ZoomBand {
  x: number; y: number; w: number; h: number;
  /** Whether a box found in the band is a whole person. */
  whole: (box: DetectedPerson["box"]) => boolean;
  /** Whether the band's ball candidates count too. */
  balls: boolean;
}

/** Tiles across a zoom band (on the Orion clip 2 tiles left 34% of the picked players' samples unseen, 3 left 30%, 4 left 36%). */
const ZOOM_TILES = 3;

/**
 * The tiles a zoom band is read in, frame pixels: `ZOOM_TILES` across it, overlapping by a quarter, each as tall as it
 * is wide (the detector stretches any picture to its own square input, so only a square tile keeps people their
 * shape), standing on the band's bottom.
 */
export function zoomTiles(band: { x: number; y: number; w: number; h: number }, width: number, height: number):
  { x: number; y: number; side: number }[] {
  const n = ZOOM_TILES;
  const side = Math.min(width, height, Math.max(band.h, band.w / (n - (n - 1) / 4)));
  const y = Math.max(0, Math.min(height - side, band.y + band.h - side));
  return Array.from({ length: n }, (_, k) => ({ x: Math.max(0, Math.min(width - side, band.x + (k * (band.w - side)) / (n - 1))), y, side }));
}

/** MediaPipe's 33 pose landmarks to the 19 keypoints the reconstruction reads (left and right are the player's own). */
const LANDMARKS: [BodyKeypoint, number][] = [
  ["nose", 0], ["leftEye", 2], ["rightEye", 5], ["leftEar", 7], ["rightEar", 8], ["leftShoulder", 11], ["rightShoulder", 12],
  ["leftElbow", 13], ["rightElbow", 14], ["leftWrist", 15], ["rightWrist", 16], ["leftHip", 23], ["rightHip", 24],
  ["leftKnee", 25], ["rightKnee", 26], ["leftAnkle", 27], ["rightAnkle", 28],
];

export class Detector {
  private constructor(private readonly people: ObjectDetector, private readonly pose: PoseLandmarker) {}

  /** Loads the models shipped with the app (they work offline once the app is on the Home Screen). */
  static async load(base = "/"): Promise<Detector> {
    const vision = await FilesetResolver.forVisionTasks(`${base}mediapipe`);
    const delegate = "GPU" as const;
    const make = async <T>(f: (d: "GPU" | "CPU") => Promise<T>) => {
      try { return await f(delegate); } catch { return await f("CPU"); }
    };
    const people = await make((d) => ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `${base}models/efficientdet_lite2.tflite`, delegate: d },
      runningMode: "IMAGE", scoreThreshold: 0.12, categoryAllowlist: ["person", "sports ball"], maxResults: 60,
    }));
    const pose = await make((d) => PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `${base}models/pose_landmarker_full.task`, delegate: d },
      runningMode: "IMAGE", numPoses: 1, minPoseDetectionConfidence: 0.2, minPosePresenceConfidence: 0.2,
    }));
    return new Detector(people, pose);
  }

  close() {
    this.people.close();
    this.pose.close();
  }

  /**
   * Everyone in a frame and the ball candidates. `wantsPose`, when given, says which people get the pose model (the
   * others keep their box only), e.g. not the spectators in the stands; `band`, when given, is read again zoomed.
   */
  detect(frame: HTMLCanvasElement | HTMLVideoElement | ImageBitmap, width: number, height: number,
    wantsPose?: (box: DetectedPerson["box"]) => boolean, band?: ZoomBand): FrameDetections {
    const { people, balls } = this.objects(frame, width, height, band);
    // Pose from a square crop around each person, about 256 px tall.
    const crop = canvas(256, 256);
    const g = crop.getContext("2d")!;
    for (const p of people) {
      if (wantsPose && !wantsPose(p.box)) continue;
      const { x, y, w, h } = p.box;
      const side = Math.max(w, h) * 1.5, cx = x + w / 2, cy = y + h / 2;
      g.clearRect(0, 0, 256, 256);
      g.drawImage(frame, cx - side / 2, cy - side / 2, side, side, 0, 0, 256, 256);
      const r = this.pose.detect(crop);
      const lm = r.landmarks[0];
      if (!lm) continue;
      const at = (i: number): Keypoint => ({ x: cx - side / 2 + lm[i].x * side, y: cy - side / 2 + lm[i].y * side, confidence: lm[i].visibility ?? 0.5 });
      for (const [name, i] of LANDMARKS) p.keypoints[name] = at(i);
      const mid = (a: Keypoint, b: Keypoint): Keypoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, confidence: Math.min(a.confidence, b.confidence) });
      p.keypoints.neck = mid(at(11), at(12));
      p.keypoints.root = mid(at(23), at(24));
    }
    return { people, balls };
  }

  /** The ball candidates in a frame, best first: the object detector alone, for the frames between the pose frames. */
  detectBalls(frame: HTMLCanvasElement | HTMLVideoElement | ImageBitmap, width: number, height: number, band?: ZoomBand): FrameDetections["balls"] {
    return this.objects(frame, width, height, band?.balls ? band : undefined).balls;
  }

  /** People (boxes only) and ball candidates from the object detector. */
  private objects(frame: HTMLCanvasElement | HTMLVideoElement | ImageBitmap, width: number, height: number, band?: ZoomBand): FrameDetections {
    // Two overlapping tiles (the detector's input is square-ish). It stretches each tile to its own 448 x 448 input,
    // so the upscale does not make anyone larger to it: the zoomed band does that.
    const S = width < 1400 ? 2 : 1;
    const big = canvas(width * S, height * S);
    big.getContext("2d")!.drawImage(frame, 0, 0, big.width, big.height);
    const tw = Math.round(big.width * 0.6);
    const raw: DetectedPerson[] = [];
    const balls: FrameDetections["balls"] = [];
    for (const x0 of [0, big.width - tw]) {
      const tile = canvas(tw, big.height);
      tile.getContext("2d")!.drawImage(big, x0, 0, tw, big.height, 0, 0, tw, big.height);
      for (const d of this.people.detect(tile).detections) {
        const b = d.boundingBox!, c = d.categories[0];
        if (c.categoryName === "sports ball") {
          const box = { x: (b.originX + x0) / S, y: b.originY / S, w: b.width / S, h: b.height / S };
          balls.push(ballCandidate(box, c.score, { x: x0 / S, y: 0, w: tw / S, h: height }, width, height));
        } else {
          raw.push({ box: { x: (b.originX + x0) / S, y: b.originY / S, w: b.width / S, h: b.height / S }, score: c.score, keypoints: {} });
        }
      }
    }
    if (band) this.zoomed(frame, width, height, band, raw, balls);
    // The tiles overlap: one person, one box.
    raw.sort((a, b) => b.score - a.score);
    const people: DetectedPerson[] = [];
    for (const p of raw) if (!people.some((q) => iou(q.box, p.box) > 0.5)) people.push(p);
    return { people, balls: oneBallEach(balls) };
  }

  /**
   * The band read again in its tiles (`zoomTiles`). A person box that a tile's edge cuts (not the frame's: the next
   * tile or the main pass sees that person whole) is left out, as is one the band says is not a whole person.
   */
  private zoomed(frame: HTMLCanvasElement | HTMLVideoElement | ImageBitmap, width: number, height: number, band: ZoomBand,
    people: DetectedPerson[], balls: FrameDetections["balls"]) {
    const tile = canvas(MODEL_INPUT, MODEL_INPUT);
    const g = tile.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    for (const { x: x0, y: y0, side } of zoomTiles(band, width, height)) {
      const s = side / MODEL_INPUT, edge = 2 * s;
      g.clearRect(0, 0, MODEL_INPUT, MODEL_INPUT);
      g.drawImage(frame, x0, y0, side, side, 0, 0, MODEL_INPUT, MODEL_INPUT);
      for (const d of this.people.detect(tile).detections) {
        const b = d.boundingBox!, c = d.categories[0];
        const box = { x: x0 + b.originX * s, y: y0 + b.originY * s, w: b.width * s, h: b.height * s };
        if (c.categoryName === "sports ball") {
          if (band.balls) balls.push(ballCandidate(box, c.score, { x: x0, y: y0, w: side, h: side }, width, height));
          continue;
        }
        const cut = (x0 > 0 && box.x <= x0 + edge) || (x0 + side < width && box.x + box.w >= x0 + side - edge)
          || (y0 > 0 && box.y <= y0 + edge) || (y0 + side < height && box.y + box.h >= y0 + side - edge);
        if (!cut && band.whole(box)) people.push({ box, score: c.score, keypoints: {} });
      }
    }
  }
}

/**
 * A ball candidate from its box (frame pixels) in a tile: the centre, and the smaller side as the ball's diameter
 * unless the frame's edge or the tile's cuts the box (within 2 px).
 */
function ballCandidate(box: DetectedPerson["box"], score: number, tile: DetectedPerson["box"], width: number, height: number):
  FrameDetections["balls"][number] {
  const at = { x: box.x + box.w / 2, y: box.y + box.h / 2, score };
  const edge = 2;
  const cut = box.x <= Math.max(0, tile.x) + edge || box.y <= Math.max(0, tile.y) + edge
    || box.x + box.w >= Math.min(width, tile.x + tile.w) - edge || box.y + box.h >= Math.min(height, tile.y + tile.h) - edge;
  return cut ? at : { ...at, size: Math.min(box.w, box.h) };
}

/**
 * Ball candidates best first, one per ball: the tiles overlap, and where a tile's edge cuts a ball's box the other
 * tile sees it whole, so of two candidates closer than half a ball (at least 4 px) the better scoring stays, with the
 * centre and size of a whole box when it has none.
 */
export function oneBallEach(balls: readonly FrameDetections["balls"][number][]): FrameDetections["balls"] {
  const kept: FrameDetections["balls"] = [];
  for (const b of [...balls].sort((p, q) => q.score - p.score)) {
    const twin = kept.find((k) => Math.hypot(k.x - b.x, k.y - b.y) <= Math.max(4, 0.5 * (k.size ?? b.size ?? 0)));
    if (!twin) kept.push({ ...b });
    else if (twin.size === undefined && b.size !== undefined) Object.assign(twin, { x: b.x, y: b.y, size: b.size });
  }
  return kept;
}

/** The object detector's input (EfficientDet-Lite2: 448 x 448). */
const MODEL_INPUT = 448;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function iou(a: DetectedPerson["box"], b: DetectedPerson["box"]): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = ix * iy;
  return i / (a.w * a.h + b.w * b.h - i);
}
