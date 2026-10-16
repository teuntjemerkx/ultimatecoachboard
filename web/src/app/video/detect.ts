import { FilesetResolver, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";

/**
 * People and the ball in one video frame with Google's MediaPipe models, running in the browser on the iPad (no
 * Apple frameworks, nothing uploaded). Two stages, as broadcast footage needs: a person detector finds everyone
 * (also the small players on the far side) on an upscaled, tiled frame, then the pose model reads each person from
 * a crop of their own. Pixel coordinates of the frame, origin top-left.
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
  /** Ball candidates, best first. */
  balls: { x: number; y: number; score: number }[];
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
   * others keep their box only), e.g. not the spectators in the stands.
   */
  detect(frame: HTMLCanvasElement | HTMLVideoElement | ImageBitmap, width: number, height: number,
    wantsPose?: (box: DetectedPerson["box"]) => boolean): FrameDetections {
    // Upscale so far players are large enough, and cut into two overlapping tiles (the detector's input is square-ish).
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
          balls.push({ x: (b.originX + b.width / 2 + x0) / S, y: (b.originY + b.height / 2) / S, score: c.score });
        } else {
          raw.push({ box: { x: (b.originX + x0) / S, y: b.originY / S, w: b.width / S, h: b.height / S }, score: c.score, keypoints: {} });
        }
      }
    }
    // The tiles overlap: one person, one box.
    raw.sort((a, b) => b.score - a.score);
    const people: DetectedPerson[] = [];
    for (const p of raw) if (!people.some((q) => iou(q.box, p.box) > 0.5)) people.push(p);
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
    balls.sort((a, b) => b.score - a.score);
    return { people, balls };
  }
}

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
