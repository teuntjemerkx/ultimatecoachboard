// Test helpers of the video tests (ports of VideoTests.swift's SplitMix64 extension and its `Synth` data).
import type { FloorPoint } from "../match/court";
import { V3 } from "../spatial/math3d";
import { Posture, type SkeletonModel } from "../spatial/skeleton";
import { SplitMix64 } from "../spatial/testSupport";
import { CalibrationPoint, CourtLandmark, VideoCamera } from "./courtCalibration";
import { BodyKeypoint, type Keypoints } from "./playerTracking";
import { skeletonKeypoints } from "./poseFitting";
import type { ImagePoint } from "./videoMath";

export { SplitMix64 };

const mask64 = 0xffffffffffffffffn;

/** Uniform in [0, 1). */
export function unit(rng: SplitMix64): number {
  return Number(rng.next() >> 11n) / 2 ** 53;
}

export function uniform(rng: SplitMix64, a: number, b: number): number {
  return a + (b - a) * unit(rng);
}

/** Standard normal (Box-Muller). */
export function gaussian(rng: SplitMix64): number {
  const u = Math.max(unit(rng), 1e-12), v = unit(rng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function chance(rng: SplitMix64, p: number): boolean {
  return unit(rng) < p;
}

/** Swift's `RandomNumberGenerator.next(upperBound:)` (Lemire's nearly divisionless method). */
function nextBelow(rng: SplitMix64, upper: number): number {
  const u = BigInt(upper);
  let m = rng.next() * u;
  if ((m & mask64) < u) {
    const t = ((1n << 64n) - u) % u;
    while ((m & mask64) < t) m = rng.next() * u;
  }
  return Number(m >> 64n);
}

/** Swift `shuffled(using:)` (Fisher-Yates from the front). */
export function shuffled<T>(items: readonly T[], rng: SplitMix64): T[] {
  const out = [...items];
  let amount = out.length, current = 0;
  while (amount > 1) {
    const r = nextBelow(rng, amount);
    amount -= 1;
    const j = current + r;
    [out[current], out[j]] = [out[j], out[current]];
    current += 1;
  }
  return out;
}

/** Synthetic data for the video-to-3D tests: cameras, noise, players, keypoints. */
export const Synth = {
  /** High in the stands behind the home end line. */
  stands: VideoCamera.lookingAt(new V3(1.5, 8, 21), new V3(0, 0, -1), 1500, 1920, 1080),
  /** On the left sideline (home view), 3 m up. */
  sideline: VideoCamera.lookingAt(new V3(-15, 3, 1), new V3(0, 0.5, 0), 950, 1920, 1080),
  /** A low tripod behind the home end line. */
  tripod: VideoCamera.lookingAt(new V3(0.8, 1.5, 15), new V3(0, 0.8, 0), 1000, 1920, 1080),

  noisy(p: ImagePoint, rng: SplitMix64, amplitude: number): ImagePoint {
    const x = p.x + uniform(rng, -amplitude, amplitude);
    const y = p.y + uniform(rng, -amplitude, amplitude);
    return { x, y };
  },

  landmarks(cam: VideoCamera, rng: SplitMix64, noise: number, list: readonly CourtLandmark[] = CourtLandmark.allCases): CalibrationPoint[] {
    return list.map((l) => CalibrationPoint.landmark(l, Synth.noisy(cam.project(CourtLandmark.world(l))!, rng, noise)));
  },

  /**
   * The keypoints of a posed player seen by a camera, with pixel noise, dropped joints and confidences. `jump` lifts
   * the body on top of the posture's own jump; `totalJump` replaces it.
   */
  keypoints(s: SkeletonModel, posture: Posture, at: FloorPoint, yaw: number, camera: VideoCamera, rng: SplitMix64,
    options: { jump?: number; totalJump?: number; noise?: number; drop?: number; role?: string } = {}): Keypoints {
    const noise = options.noise ?? 3, drop = options.drop ?? 0.1;
    const params = Posture.params(posture, s, options.role ?? "");
    if (options.totalJump !== undefined) params.jump = options.totalJump;
    const posed = s.pose(params, at, yaw, options.jump ?? 0);
    const points = skeletonKeypoints(s, posed);
    const out: Keypoints = {};
    // In a fixed order, so the noise is reproducible.
    for (const k of BodyKeypoint.allCases) {
      if (chance(rng, drop)) continue;
      const px = camera.project(points[k]);
      if (!px) continue;
      const x = px.x + noise * gaussian(rng);
      const y = px.y + noise * gaussian(rng);
      out[k] = { point: { x, y }, confidence: uniform(rng, 0.4, 1) };
    }
    return out;
  },
};
