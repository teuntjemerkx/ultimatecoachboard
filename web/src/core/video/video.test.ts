// Port of CoachBoardCoreTests/VideoTests.swift (MathVideoTests, CalibrationVideoTests, TrackingVideoTests,
// PoseVideoTests, BallVideoTests, EnvironmentVideoTests, SceneVideoTests).
import { describe, expect, it } from "vitest";
import { Side, type FloorPoint } from "../match/court";
import { Aero, BallFlight, FlightSolver, type FlightSample } from "../spatial/ballFlight";
import { V3 } from "../spatial/math3d";
import { BodyMetrics, Joint, Posture, SkeletonModel } from "../spatial/skeleton";
import { maxBy, minBy, referenceDateOffset } from "../spatial/swiftCompat";
import { expectClose, strideThrough } from "../spatial/testSupport";
import { SceneToken } from "../zones/tacticalScene";
import { BallAnchor, BallReconstruction, BallSegment, type BallObservation } from "./ballReconstruction";
import { CourtCalibration, CourtLandmark, VideoCamera } from "./courtCalibration";
import { CleanPlate, HallEnvironment } from "./environment";
import { PersonDetection, PlayerTracker, type TrackedPlayer, type VideoFrameObservation } from "./playerTracking";
import { PoseFitter, type PoseTrackFrame } from "./poseFitting";
import { SplitMix64, Synth, chance, shuffled, uniform, unit } from "./testSupport";
import { Hungarian, ImagePoint, LevenbergMarquardt, LinearAlgebra, Matrix3, wrappedAngle } from "./videoMath";
import { VideoPlayerSample, VideoPlayerTrack, VideoReconstructor, VideoScene, type ReconstructionStage } from "./videoScene";

const deg = (d: number) => (d * Math.PI) / 180;

describe("MathVideoTests", () => {
  it("Jacobi eigen and nearest rotation", () => {
    const rng = new SplitMix64(1);
    // A random symmetric 9 x 9 matrix: A v = lambda v for every pair, values ascending.
    const a = new Array<number>(81).fill(0);
    for (let i = 0; i < 9; i++) for (let j = i; j < 9; j++) { const x = uniform(rng, -1, 1); a[i * 9 + j] = x; a[j * 9 + i] = x; }
    const { values, vectors } = LinearAlgebra.symmetricEigen(a, 9);
    expect(values).toEqual([...values].sort((x, y) => x - y));
    values.forEach((lambda, k) => {
      const v = vectors[k];
      for (let i = 0; i < 9; i++) {
        let av = 0;
        for (let j = 0; j < 9; j++) av += a[i * 9 + j] * v[j];
        expectClose(av, lambda * v[i], 1e-9);
      }
    });
    // A rotation perturbed by noise projects back onto a nearby proper rotation; a reflection is fixed too.
    const r = Matrix3.rotation(new V3(0.3, -1.1, 0.7));
    const noisy = Matrix3.rows(r.r0.add(new V3(0.01, -0.02, 0)), r.r1.add(new V3(0, 0.015, 0.01)), r.r2.mul(1.05));
    const p = LinearAlgebra.nearestRotation(noisy);
    expectClose(p.determinant, 1, 1e-9);
    expectClose(p.transpose.mul(p).r0.x, 1, 1e-9);
    expect(p.r0.sub(r.r0).length + p.r1.sub(r.r1).length + p.r2.sub(r.r2).length).toBeLessThan(0.05);
    const flipped = LinearAlgebra.nearestRotation(Matrix3.rows(r.r0, r.r1, r.r2.neg()));
    expectClose(flipped.determinant, 1, 1e-9);
  });

  it("Hungarian matches brute force", () => {
    const rng = new SplitMix64(2);
    const permutations = (n: number): number[][] => {
      if (n === 1) return [[0]];
      return permutations(n - 1).flatMap((p) => Array.from({ length: p.length + 1 }, (_, i) => {
        const q = [...p];
        q.splice(i, 0, n - 1);
        return q;
      }));
    };
    for (let trial = 0; trial < 40; trial++) {
      const rows = 2 + (trial % 4), cols = 2 + (Math.floor(trial / 4) % 4);
      const cost = Array.from({ length: rows }, () => Array.from({ length: cols }, () => uniform(rng, 0, 10)));
      const a = Hungarian.solve(cost);
      let total = 0;
      a.forEach((c, r) => { if (c !== undefined) total += cost[r][c]; });
      const used = a.filter((c): c is number => c !== undefined);
      expect(used.length).toBe(Math.min(rows, cols));
      expect(new Set(used).size).toBe(Math.min(rows, cols));
      // Brute force over assignments of the smaller side.
      const n = Math.max(rows, cols);
      let best = Infinity;
      for (const p of permutations(n)) {
        let s = 0;
        for (let r = 0; r < rows; r++) if (p[r] < cols) s += cost[r][p[r]];
        best = Math.min(best, s);
      }
      expectClose(total, best, 1e-9);
    }
  });

  it("Levenberg-Marquardt fits Rosenbrock", () => {
    const r = LevenbergMarquardt.minimize([-1.2, 1], [1e-7, 1e-7], (x) => [10 * (x[1] - x[0] * x[0]), 1 - x[0]], { maxIterations: 200 });
    expectClose(r!.x[0], 1, 1e-6);
    expectClose(r!.x[1], 1, 1e-6);
  });
});

describe("CalibrationVideoTests", () => {
  it("camera projection, rays and renderer pose", () => {
    const cam = Synth.stands;
    const p = new V3(2, 1.3, 4);
    const px = cam.project(p)!;
    // The ray through the pixel passes through the point; the floor point under a floor point is itself.
    const ray = cam.ray(px);
    const t = p.sub(ray.origin).dot(ray.direction);
    expect(ray.origin.add(ray.direction.mul(t)).sub(p).length).toBeLessThan(1e-9);
    const fp = cam.floorPoint(cam.project(new V3(-3, 0, 6))!)!;
    expectClose(fp.x, -3, 1e-9);
    expectClose(fp.z, 6, 1e-9);
    const ankle = cam.floorPoint(cam.project(new V3(1, 0.08, 2))!, 0.08)!;
    expectClose(ankle.x, 1, 1e-9);
    // Height above a floor point: a head at 1.85 m above (2, 4) reads 1.85.
    expectClose(cam.heightAbove(cam.project(new V3(2, 1.85, 4))!, { x: 2, z: 4 })!, 1.85, 1e-9);
    expect(cam.project(new V3(0, 8, 30)), "behind the camera").toBeUndefined();
    // The renderer pose reproduces the projection (NDC y up, aspect = width / height).
    const pose = cam.cameraPose;
    const ndc = pose.project(p, cam.width / cam.height)!;
    expectClose(ndc.x, (px.x - cam.width / 2) / (cam.width / 2), 1e-9);
    expectClose(ndc.y, -(px.y - cam.height / 2) / (cam.height / 2), 1e-9);
    expectClose(pose.fovY, 2 * Math.atan(1080 / 3000), 1e-12);
    expect(pose.near).toBe(0.05);
    expect(pose.up.y).toBeGreaterThan(0.8);
    // Every landmark of the synthetic cameras is in frame.
    for (const c of [Synth.stands, Synth.sideline, Synth.tripod]) {
      for (const l of CourtLandmark.allCases) expect(c.contains(c.project(CourtLandmark.world(l))!, 10), l).toBe(true);
    }
  });

  it("homography maps the floor", () => {
    const cam = Synth.sideline;
    const floor = CourtLandmark.allCases.filter((l) => CourtLandmark.isOnFloor(l)).map((l) => CourtLandmark.world(l));
    const h = CourtCalibration.homography(floor.map((p) => p.floor), floor.map((p) => cam.project(p)!))!;
    expect(h).toBeDefined();
    const m = Matrix3.fromValues(h);
    for (const p of [new V3(1, 0, 2), new V3(-4, 0, -7), new V3(3.3, 0, 8)]) {
      const q = m.apply(new V3(p.x, p.z, 1)), px = cam.project(p)!;
      expectClose(q.x / q.z, px.x, 1e-6);
      expectClose(q.y / q.z, px.y, 1e-6);
    }
    // Three collinear points and a duplicate cannot define it.
    const line: FloorPoint[] = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 0 }];
    expect(CourtCalibration.homography(line, line.map((p) => cam.project(V3.fromFloor(p))!))).toBeUndefined();
  });

  /** Mark positions with +-1 px noise recover the camera of three typical set-ups. */
  it("recovers synthetic cameras", () => {
    const rng = new SplitMix64(3);
    const setups: [string, VideoCamera, (p: FloorPoint) => boolean][] = [
      ["stands", Synth.stands, (p) => p.z >= 0],
      ["sideline", Synth.sideline, (p) => p.x <= 0],
      ["tripod", Synth.tripod, (p) => p.z >= 0],
    ];
    for (const [name, truth, near] of setups) {
      for (let trial = 0; trial < 5; trial++) {
        const points = Synth.landmarks(truth, rng, 1);
        const r = CourtCalibration.solve(points, 1920, 1080)!;
        expect(r, name).toBeDefined();
        expect(r.quality, `${name} ${trial}`).toBe("good");
        expect(r.rmsError, name).toBeLessThan(1.2);
        expectClose(r.camera.focalLength / truth.focalLength, 1, 0.03, `${name} focal`);
        expect(r.camera.center.sub(truth.center).length, `${name} centre`).toBeLessThan(0.3);
        // Floor back-projection in the near half.
        let worst = 0, sum = 0, count = 0;
        for (const x of strideThrough(-4.5, 4.5, 1.5)) {
          for (const z of strideThrough(-9, 9, 1.5)) {
            if (!near({ x, z })) continue;
            const px = truth.project(new V3(x, 0, z))!;
            const fp = r.camera.floorPoint(px)!;
            const e = Math.hypot(fp.x - x, fp.z - z);
            worst = Math.max(worst, e);
            sum += e * e;
            count += 1;
          }
        }
        expect(Math.sqrt(sum / count), `${name} near floor error`).toBeLessThan(0.05);
        expect(worst, `${name} worst near floor error`).toBeLessThan(0.08);
      }
    }
  });

  /** The coach's four dots, pairs in any left/right order. */
  it("four corners in any order", () => {
    const rng = new SplitMix64(4);
    for (const truth of [Synth.stands, Synth.sideline, Synth.tripod]) {
      const px = (l: CourtLandmark) => Synth.noisy(truth.project(CourtLandmark.world(l))!, rng, 1);
      const ours = [px("homeEndLeft"), px("homeEndRight")], theirs = [px("opponentEndLeft"), px("opponentEndRight")];
      const rev = <T>(a: T[]) => [...a].reverse();
      for (const [a, b] of [[ours, theirs], [rev(ours), theirs], [ours, rev(theirs)], [rev(ours), rev(theirs)]]) {
        const r = CourtCalibration.solveCorners(a, b, 1920, 1080)!;
        expect(r).toBeDefined();
        expect(r.quality).not.toBe("failed");
        expectClose(r.camera.focalLength / truth.focalLength, 1, 0.06);
        expect(r.camera.center.sub(truth.center).length).toBeLessThan(0.6);
        // The chosen assignment puts the home-left corner where the true one is.
        expect(ImagePoint.distance(r.points[0].image, truth.project(CourtLandmark.world("homeEndLeft"))!)).toBeLessThan(2);
      }
      // Near half only: end-line corners and the centre-line ends.
      const end = [px("homeEndRight"), px("homeEndLeft")], net = [px("centerLineLeft"), px("centerLineRight")];
      const r = CourtCalibration.solveNearHalf(end, net, "home", 1920, 1080)!;
      expect(r).toBeDefined();
      expect(r.quality).not.toBe("failed");
      expect(r.camera.center.sub(truth.center).length).toBeLessThan(1.0);
    }
  });

  it("nonsense input fails", () => {
    // One dot inside the triangle of the other three: no camera sees a rectangle like that.
    const r1 = CourtCalibration.solveCorners([{ x: 200, y: 900 }, { x: 1700, y: 900 }], [{ x: 950, y: 200 }, { x: 950, y: 700 }], 1920, 1080);
    expect(r1 === undefined || r1.quality === "failed").toBe(true);
    // All on one line.
    expect(CourtCalibration.solveCorners([{ x: 100, y: 500 }, { x: 500, y: 500 }], [{ x: 900, y: 500 }, { x: 1300, y: 500 }], 1920, 1080)).toBeUndefined();
    expect(CourtCalibration.solve([], 1920, 1080)).toBeUndefined();
  });
});

/** Twelve synthetic players moving smoothly on their halves (up to 5 m/s), two home players crossing paths. */
interface Wave { ax: number; az: number; w: number; phase: number }

class SyntheticPlayer {
  waves: Wave[] = [];
  line?: { from: FloorPoint; to: FloorPoint };
  constructor(readonly side: Side, readonly base: FloorPoint) {}

  position(t: number, duration: number): FloorPoint {
    if (this.line) {
      const u = t / duration;
      const { from, to } = this.line;
      return { x: from.x + (to.x - from.x) * u, z: from.z + (to.z - from.z) * u };
    }
    let x = this.base.x, z = this.base.z;
    for (const w of this.waves) {
      x += w.ax * Math.sin(w.w * t + w.phase);
      z += w.az * Math.sin(w.w * t + w.phase * 1.7);
    }
    return { x, z };
  }

  speed(t: number, duration: number): number {
    const a = this.position(t - 0.001, duration), b = this.position(t + 0.001, duration);
    return Math.hypot(b.x - a.x, b.z - a.z) / 0.002;
  }
}

class SyntheticRally {
  players: SyntheticPlayer[] = [];

  constructor(readonly duration: number, seed: number) {
    const rng = new SplitMix64(seed);
    const home: FloorPoint[] = [{ x: 3, z: 7 }, { x: 3, z: 1.5 }, { x: 0, z: 2 }, { x: -3, z: 1.5 }, { x: -3, z: 7 }, { x: 0, z: 6.5 }];
    for (const side of Side.allCases) {
      // The crossing pair first, so the wanderers keep clear of them too.
      for (const i of [0, 4, 1, 2, 3, 5]) {
        const b = home[i];
        const p = new SyntheticPlayer(side, side === "home" ? b : { x: -b.x, z: -b.z });
        if (side === "home" && (i === 0 || i === 4)) {
          // P1 and P5 run straight across each other's path.
          const z = 5.0;
          p.line = i === 0 ? { from: { x: 3.2, z: z - 0.3 }, to: { x: -3.2, z: z + 0.3 } } : { from: { x: -3.2, z }, to: { x: 3.2, z } };
        } else {
          // Smooth wandering that peaks at 2.5 to 5 m/s, stays on the player's half and keeps 0.6 m from the others
          // (bodies do not overlap).
          const steps = strideThrough(0, duration, 0.02);
          do {
            p.waves = [0, 1].map(() => {
              const ax = uniform(rng, -1.2, 1.2), az = uniform(rng, -1.0, 1.0), w = uniform(rng, 0.8, 2.2), phase = uniform(rng, 0, 6.28);
              return { ax, az, w, phase };
            });
            const top = Math.max(...steps.map((t) => p.speed(t, duration)));
            const k = uniform(rng, 2.5, 5) / top;
            p.waves = p.waves.map((w) => ({ ax: w.ax * k, az: w.az * k, w: w.w, phase: w.phase }));
          } while (steps.some((t) => {
            const q = p.position(t, duration);
            const d = side === "home" ? q.z : -q.z;
            const crowded = this.players.some((o) => {
              const r = o.position(t, duration);
              return o.side === side && Math.hypot(r.x - q.x, r.z - q.z) < 0.6;
            });
            return Math.abs(q.x) > 4.3 || d < 0.6 || d > 8.8 || crowded;
          }));
        }
        this.players.push(p);
      }
    }
  }

  /** Frame times at about `fps` with up to 15% jitter. */
  static times(duration: number, fps: number, rng: SplitMix64): number[] {
    let t = 0;
    const out: number[] = [];
    while (t <= duration + 1e-9) {
      out.push(t);
      t += (1 / fps) * uniform(rng, 0.85, 1.15);
    }
    return out;
  }
}

describe("TrackingVideoTests", () => {
  const trackRally = (seed: number) => {
    const rng = new SplitMix64(seed * 7);
    const rally = new SyntheticRally(4, seed);
    const times = SyntheticRally.times(rally.duration, 15, rng);
    const frames: VideoFrameObservation[] = [];
    for (const t of times) {
      const dets: PersonDetection[] = [];
      for (const p of rally.players) {
        if (chance(rng, 0.1)) continue;
        const q = p.position(t, rally.duration);
        const mx = q.x + uniform(rng, -0.1, 0.1), mz = q.z + uniform(rng, -0.1, 0.1);
        dets.push(PersonDetection.create({ x: mx, z: mz }, { x: 0, y: 0 }, { confidence: uniform(rng, 0.5, 1) }));
      }
      // Off court: the bench, a line judge, spectators; now and then a one-frame ghost on court.
      for (let k = 0; k < 2; k++) {
        const x = chance(rng, 0.5) ? uniform(rng, 7, 10) : uniform(rng, -10, -7);
        dets.push(PersonDetection.create({ x, z: uniform(rng, -12, 12) }, { x: 0, y: 0 }));
      }
      const jx = uniform(rng, -3, 3);
      dets.push(PersonDetection.create({ x: jx, z: chance(rng, 0.5) ? 12.5 : -12.5 }, { x: 0, y: 0 }));
      if (chance(rng, 0.05)) {
        const gx = uniform(rng, -4, 4);
        dets.push(PersonDetection.create({ x: gx, z: uniform(rng, -8, 8) }, { x: 0, y: 0 }));
      }
      frames.push({ time: t, detections: shuffled(dets, rng) });
    }
    const tracks = new PlayerTracker().track(frames);
    expect(tracks.filter((t) => t.side === "home").length, `seed ${seed}`).toBe(6);
    expect(tracks.filter((t) => t.side === "opponent").length, `seed ${seed}`).toBe(6);
    const owner: number[] = [];
    const errors: number[] = [];
    for (const tr of tracks) {
      // The true player this track follows (nearest on average), and its error against that player throughout.
      const meanError = (i: number) => tr.samples.reduce((s, x) => {
        const q = rally.players[i].position(x.time, rally.duration);
        return s + Math.hypot(q.x - x.floor.x, q.z - x.floor.z);
      }, 0);
      const best = minBy(rally.players.map((_, i) => i), meanError)!;
      owner.push(best);
      expect(rally.players[best].side).toBe(tr.side);
      let worst = 0;
      for (const s of tr.samples) {
        const q = rally.players[best].position(s.time, rally.duration);
        const e = Math.hypot(q.x - s.floor.x, q.z - s.floor.z);
        worst = Math.max(worst, e);
        errors.push(e);
      }
      expect(worst, `seed ${seed}: track of player ${best} jumps to someone else`).toBeLessThan(0.5);
      expect(tr.samples.length, "a track covers the whole clip").toBe(times.length);
      expect(tr.samples.some((s) => s.occluded), "missed detections are interpolated and flagged").toBe(true);
    }
    expect(new Set(owner).size, `seed ${seed}: every player has exactly one track`).toBe(12);
    errors.sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length / 2)], `seed ${seed}: median position error`).toBeLessThan(0.1);
  };

  it("tracks twelve players without identity switches", () => {
    for (const seed of [22, 23, 24, 25]) trackRally(seed);
  }, 60_000);

  /**
   * Two players meet head-on (0.1 m apart) and both turn back: positions alone cannot say who is who at the bounce;
   * their jersey shades keep them apart.
   */
  it("appearance keeps identities through a near collision", () => {
    const rng = new SplitMix64(26);
    const path = (i: number, t: number): FloorPoint => {
      // Toward each other at 3 m/s until t = 1, then back the way they came.
      const x = 3 * (1 - Math.abs(t - 1)) - 0.05;
      return i === 0 ? { x: -3 + x, z: 4 } : { x: 3 - x, z: 4 };
    };
    const frames = (withAppearance: boolean): VideoFrameObservation[] =>
      strideThrough(0, 2, 1 / 15).map((t) => ({
        time: t,
        detections: [0, 1].map((i) => {
          const p = path(i, t);
          const shade = withAppearance ? [i === 0 ? 0.8 : 0.3, 0.2, 0.2].map((v) => v + uniform(rng, -0.05, 0.05)) : undefined;
          const fx = p.x + uniform(rng, -0.05, 0.05), fz = p.z + uniform(rng, -0.05, 0.05);
          return PersonDetection.create({ x: fx, z: fz }, { x: 0, y: 0 }, { appearance: shade });
        }),
      }));
    const followsItsPlayer = (tracks: TrackedPlayer[]) => tracks.every((tr) => {
      const start = tr.samples[0].floor.x < 0 ? 0 : 1;
      return tr.samples.every((s) => Math.abs(s.floor.x - path(start, s.time).x) < 0.4);
    });
    const tracks = new PlayerTracker().track(frames(true));
    expect(tracks.length).toBe(2);
    expect(followsItsPlayer(tracks)).toBe(true);
  });

  it("sides are kept and the per-side cap holds", () => {
    // Seven people on the home half (an extra one now and then), and a home blocker reaching under the net.
    const frames: VideoFrameObservation[] = [];
    for (let k = 0; k < 30; k++) {
      const t = k / 15;
      const dets = Array.from({ length: 6 }, (_, i) =>
        PersonDetection.create({ x: -4 + i * 1.6, z: 3 + 0.2 * Math.sin(t + i) }, { x: 0, y: 0 }));
      if (k % 3 === 0) dets.push(PersonDetection.create({ x: 0, z: 8 }, { x: 0, y: 0 }));
      dets.push(PersonDetection.create({ x: 1, z: 0.35 - 0.65 * Math.sin((k / 29) * Math.PI) }, { x: 0, y: 0 }));
      frames.push({ time: t, detections: dets });
    }
    const tracks = new PlayerTracker().track(frames);
    expect(tracks.filter((t) => t.side === "home").length).toBeLessThanOrEqual(6);
    expect(tracks.filter((t) => t.side === "opponent"), "reaching under the net does not change sides").toEqual([]);
  });
});

describe("PoseVideoTests", () => {
  it("single-frame fit recovers posture and facing", () => {
    const rng = new SplitMix64(31);
    const fitter = new PoseFitter(1.95);
    const s = new SkeletonModel(new BodyMetrics(1.95));
    let yawOK = 0, postureOK = 0, n = 0;
    const misses: string[] = [];
    for (let i = 0; i < 192; i++) {
      const cam = i % 2 === 0 ? Synth.stands : Synth.sideline;
      const posture = Posture.allCases[i % Posture.allCases.length];
      const yaw = uniform(rng, -Math.PI, Math.PI);
      const px = uniform(rng, -4, 4), pz = uniform(rng, -8.5, 8.5);
      const pos = { x: px, z: pz };
      const kp = Synth.keypoints(s, posture, pos, yaw, cam, rng, { noise: 3, drop: 0.1 });
      const e = fitter.fit(kp, pos, cam)!;
      expect(e).toBeDefined();
      n += 1;
      if (Math.abs(wrappedAngle(e.yaw - yaw)) < deg(20)) yawOK += 1;
      if (PoseFitter.equivalent(e.posture, posture)) postureOK += 1;
      else misses.push(`${posture}->${e.posture}`);
    }
    expect(yawOK / n, "facing within 20 degrees").toBeGreaterThanOrEqual(0.9);
    expect(postureOK / n, `posture or an equivalent: ${misses.join(", ")}`).toBeGreaterThanOrEqual(0.8);
  }, 30_000);

  it("jump height of a block", () => {
    const rng = new SplitMix64(32);
    const fitter = new PoseFitter(1.95);
    const s = new SkeletonModel(new BodyMetrics(1.95));
    expect(fitter.isAirborne("block")).toBe(true);
    expect(fitter.isAirborne("ready")).toBe(false);
    for (const [cam, extra] of [[Synth.stands, 0.2], [Synth.sideline, 0.0], [Synth.tripod, 0.35]] as const) {
      const pos = { x: 1, z: 0.6 };
      const kp = Synth.keypoints(s, "block", pos, Math.PI, cam, rng, { jump: extra, noise: 2, drop: 0 });
      const j = fitter.estimateJump("block", Math.PI, kp, pos, cam)!;
      expectClose(j, fitter.libraryJump("block") + extra, 0.08);
    }
  });

  it("track smoothing removes single-frame flips", () => {
    const rng = new SplitMix64(33);
    const fitter = new PoseFitter(1.95);
    const s = new SkeletonModel(new BodyMetrics(1.95));
    const cam = Synth.stands;
    const frames: PoseTrackFrame[] = [];
    const truth: [Posture, number][] = [];
    for (let k = 0; k < 30; k++) {
      const t = k / 15;
      const pos = { x: -1 + 0.05 * k, z: 4 };
      // Ready facing the net, then a sustained turn to the right and a pass from frame 18.
      let posture: Posture = k < 18 ? "ready" : "pass";
      let yaw = k < 18 ? Math.PI : Math.PI - 1.2;
      truth.push([posture, yaw]);
      // Single-frame glitches: the body read back to front, a stray posture.
      if (k === 7) yaw += Math.PI;
      if (k === 11) posture = "standing";
      frames.push({ time: t, floor: pos,
        keypoints: k === 14 ? undefined : Synth.keypoints(s, posture, pos, yaw, cam, rng, { noise: 3, drop: 0.1 }) });
    }
    // Single frames alone do follow the glitches.
    const single = fitter.fit(frames[7].keypoints!, frames[7].floor, cam)!;
    expect(Math.abs(wrappedAngle(single.yaw - truth[7][1]))).toBeGreaterThan(2.5);
    const result = fitter.fitTrack(frames, cam, Math.PI);
    result.estimates.forEach((e, k) => {
      expect(Math.abs(wrappedAngle(e.yaw - truth[k][1])), `frame ${k} facing`).toBeLessThan(deg(20));
      if (k !== 18) expect(PoseFitter.equivalent(e.posture, truth[k][0]), `frame ${k}: ${e.posture}`).toBe(true);
      expect(e.jump).toBe(0);
    });
    expect(result.estimates[14].confidence, "no keypoints, no confidence").toBe(0);
    expect(result.estimates[3].confidence).toBeGreaterThan(0.3);
  });

  it("airborne floor points follow the take-off-to-landing line", () => {
    const times = Array.from({ length: 10 }, (_, k) => k / 10);
    const inJump = (k: number) => k >= 3 && k <= 6;
    // Feet in the air push the floor point away from the camera during frames 3...6.
    const floor = Array.from({ length: 10 }, (_, k) => ({ x: 0.2 * k, z: inJump(k) ? 5 + k : 2 }));
    const airborne = Array.from({ length: 10 }, (_, k) => inJump(k));
    const fixed = PoseFitter.correctAirborneFloor(floor, times, airborne);
    for (let k = 0; k < 10; k++) {
      expectClose(fixed[k].x, 0.2 * k, 1e-9);
      expectClose(fixed[k].z, 2, 1e-9);
    }
    // A run at the end holds the take-off point; an overlong run is left alone.
    const end = PoseFitter.correctAirborneFloor(floor, times, Array.from({ length: 10 }, (_, k) => k >= 8));
    expect(end[9]).toEqual(floor[7]);
    const long = PoseFitter.correctAirborneFloor(floor, times.map((t) => t * 5), airborne);
    expect(long).toEqual(floor);
  });

  it("detection from keypoints stands on the feet", () => {
    const rng = new SplitMix64(34);
    const s = new SkeletonModel(new BodyMetrics(1.95));
    const pos = { x: 2, z: 5 };
    const kp = Synth.keypoints(s, "ready", pos, Math.PI, Synth.stands, rng, { noise: 0, drop: 0 });
    const d = PersonDetection.fromKeypoints(kp, 0.9, Synth.stands)!;
    expect(d).toBeDefined();
    expect(Math.hypot(d.floor.x - pos.x, d.floor.z - pos.z)).toBeLessThan(0.25);
  });
});

/** A simulated ball flight (the core's RK4 model at 1 ms), interpolated. */
class SyntheticFlight {
  readonly samples: FlightSample[];

  /** Flies for `duration` seconds or until the ball lands. */
  constructor(p0: V3, v0: V3, aero: Aero, duration: number) {
    this.samples = BallFlight.simulate(p0, v0, aero, (s) => s.p.y <= BallFlight.radius, { dt: 0.001, maxTime: duration, keepEvery: 1 });
  }

  get duration(): number {
    return this.samples[this.samples.length - 1].t;
  }

  position = (t: number): V3 => {
    const i = Math.max(0, Math.min(this.samples.length - 2, Math.trunc(t / 0.001)));
    const a = this.samples[i], b = this.samples[i + 1];
    return a.p.add(b.p.sub(a.p).mul((t - a.t) / (b.t - a.t)));
  };

  /** Velocity aimed from p0 toward a target at `speed`, raised by `elevation` radians. */
  static aim(p0: V3, target: V3, speed: number, elevation: number): V3 {
    const d = target.sub(p0).normalized;
    const flat = new V3(d.x, 0, d.z).normalized;
    const pitch = Math.asin(Math.max(-1, Math.min(1, d.y))) + elevation;
    return flat.mul(Math.cos(pitch)).add(V3.up.mul(Math.sin(pitch))).mul(speed);
  }
}

describe("BallVideoTests", () => {
  const observe = (position: (t: number) => V3, t0: number, t1: number, fps: number, phase: number, camera: VideoCamera,
    rng: SplitMix64): BallObservation[] => {
    const out: BallObservation[] = [];
    let t = t0 + phase / fps;
    while (t <= t1) {
      const px = camera.project(position(t));
      if (px && camera.contains(px)) out.push({ time: t, image: Synth.noisy(px, rng, 1.5) });
      t += 1 / fps;
    }
    return out;
  };

  /**
   * Serve, set and attack, each anchored as the pipeline does: the contact at the hand of the fitted pose of the
   * player who played it (to +-0.2 m) and the landing on the floor or at the next player.
   */
  const serveSetAttack = (seed: number) => {
    const rng = new SplitMix64(seed);
    const cam = Synth.stands;
    const serveFrom = new V3(1, 2.7, 10.5), setFrom = new V3(-0.5, 2.5, 0.8), attackFrom = new V3(3.4, 3.2, -0.5);
    const flights: [string, SyntheticFlight, boolean, Posture][] = [
      ["float serve", new SyntheticFlight(serveFrom, SyntheticFlight.aim(serveFrom, new V3(-1, 2.6, -2), 16, 0.12), Aero.float, 2), true, "floatServe"],
      ["high set", new SyntheticFlight(setFrom, new V3(-2.1, 7.2, -0.25), Aero.soft, 1.45), false, "set"],
      ["attack", new SyntheticFlight(attackFrom, SyntheticFlight.aim(attackFrom, new V3(0.5, 0.1, 6.5), 25, 0), Aero.topspin, 1), true, "attack"],
    ];
    for (const [name, flight, endsOnFloor, posture] of flights) {
      const contact = (t: number): BallAnchor => {
        const p = flight.position(t);
        const x = p.x + uniform(rng, -0.2, 0.2), y = p.y + uniform(rng, -0.2, 0.2), z = p.z + uniform(rng, -0.2, 0.2);
        return BallAnchor.hand(t, new V3(x, y, z), 0.3, t === 0 ? BallReconstruction.expectedAero(posture) : undefined);
      };
      const first = contact(0);
      const anchors = [first, endsOnFloor ? BallAnchor.floor(flight.duration) : contact(flight.duration)];
      for (const fps of [30, 60]) {
        const obs = observe(flight.position, 0, flight.duration, fps, unit(rng), cam, rng);
        const fit = BallReconstruction.fit(obs, cam, anchors)!;
        expect(fit, name).toBeDefined();
        expect(fit.rmsError, `${name} at ${fps} fps reprojects`).toBeLessThan(2.0);
        let worst = 0, near = 0;
        for (const o of obs) {
          if (!(flight.position(o.time).z > 0)) continue;
          worst = Math.max(worst, fit.position(o.time).sub(flight.position(o.time)).length);
          near += 1;
        }
        expect(near, name).toBeGreaterThan(3);
        expect(worst, `${name} at ${fps} fps: 3D error in the near half`).toBeLessThan(0.25);
      }
    }
  };

  it("reconstructs serve, set and attack", () => {
    for (const seed of [41, 141, 241, 341]) serveSetAttack(seed);
  }, 120_000);

  /**
   * Without anchors a long float flight is still metric (drag fixes the scale), but spin is not observable: the same
   * serve read as topspin would be metres off, which is why the pipeline anchors flights at contacts.
   */
  it("unanchored float flight", () => {
    const rng = new SplitMix64(43);
    const cam = Synth.stands;
    const from = new V3(1, 2.7, 10.5);
    const serve = new SyntheticFlight(from, SyntheticFlight.aim(from, new V3(-1, 2.6, -2), 16, 0.12), Aero.float, 2);
    const obs = observe(serve.position, 0, serve.duration, 30, 0.3, cam, rng);
    const fit = BallReconstruction.fit(obs, cam)!;
    expect(fit.aero).toEqual(Aero.float);
    for (const o of obs) {
      if (!(serve.position(o.time).z > 0)) continue;
      expect(fit.position(o.time).sub(serve.position(o.time)).length).toBeLessThan(0.25);
    }
  }, 30_000);

  it("splits a set and an attack at the contact", () => {
    const rng = new SplitMix64(42);
    const cam = Synth.stands;
    const contact = 1.1;
    const set = new SyntheticFlight(new V3(0.5, 2.6, 1.0), new V3(-3.4, 6.2, -0.15), Aero.soft, contact);
    const hit = set.position(contact);
    const attack = new SyntheticFlight(hit, SyntheticFlight.aim(hit, new V3(-0.5, 0.1, -6.5), 24, 0), Aero.topspin, 0.45);
    for (const fps of [30, 60]) {
      const obs = observe((t) => (t < contact ? set.position(t) : attack.position(t - contact)), 0, contact + attack.duration, fps, 0.4, cam, rng);
      const segments = BallReconstruction.segment(obs, cam);
      expect(segments.length, `${fps} fps`).toBe(2);
      if (segments.length !== 2) continue;
      expectClose(segments[0].t1, contact, 1 / fps, `contact within one frame at ${fps} fps`);
      expect(segments[1].t0).toBe(segments[0].t1);
      // Both flights are reconstructed; the ball is continuous at the contact.
      expect(segments[0].position(segments[0].t1).sub(segments[1].position(segments[1].t0)).length).toBeLessThan(0.3);
      expect(segments[0].position(0.5).sub(set.position(0.5)).length).toBeLessThan(0.25);
    }
  }, 60_000);

  it("flight never goes below the floor", () => {
    const s = new BallSegment(0, 2, new V3(0, 1, 0), new V3(0, 0, 5));
    expect(s.position(2).y).toBe(BallFlight.radius);
    expectClose(s.position(0.2).y, 1 - 0.5 * BallFlight.gravity * 0.04, 1e-12);
    const drag = new BallSegment(1, 2, new V3(0, 3, 0), new V3(0, 2, 10), { ...Aero.topspin });
    const sim = BallFlight.simulate(drag.p0, drag.v0, Aero.topspin, () => false, { dt: 0.001, maxTime: 0.5, keepEvery: 1 });
    expect(drag.position(1.5).sub(sim[sim.length - 1].p).length, "matches the core's ball model").toBeLessThan(1e-3);
  });
});

describe("EnvironmentVideoTests", () => {
  /** A gradient hall, a person walking across it, and a corner that is never seen without someone in front of it. */
  it("clean plate removes movers and fills the unseen", () => {
    const rng = new SplitMix64(51);
    const w = 40, h = 30, n = 11;
    const background = (x: number, y: number) => [x * 6, y * 8, (x + y) * 3, 255];
    const frames: Uint8Array[] = [], masks: Uint8Array[] = [];
    for (let k = 0; k < n; k++) {
      const img = new Uint8Array(w * h * 4), mask = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set(background(x, y), (y * w + x) * 4);
      // The walker: a 5 x 10 block of random colour; masked in most frames, missed by the mask in a few.
      const x0 = 2 + 3 * k, y0 = 10;
      for (let y = y0; y < y0 + 10; y++) {
        for (let x = x0; x < x0 + 5; x++) {
          const i = y * w + x;
          for (let c = 0; c < 3; c++) img[i * 4 + c] = Number(rng.next() % 256n);
          if (k % 4 !== 0) mask[i] = 1;
        }
      }
      // A bench always occupied: rows 0-3, columns 30-35, always masked.
      for (let y = 0; y < 4; y++) for (let x = 30; x < 36; x++) { mask[y * w + x] = 1; img[(y * w + x) * 4] = 0; }
      frames.push(img);
      masks.push(mask);
    }
    const plate = CleanPlate.median(frames, masks, w, h);
    expect(plate.length).toBe(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const got = Array.from(plate.subarray(i, i + 4));
        if (y < 4 && x >= 30 && x < 36) {
          // Filled from the nearest seen pixel in the row (left, right) or column (below); ties go to the row.
          const nearest = minBy([[29, y, x - 29], [36, y, 36 - x], [x, 4, 4 - y]], (c) => c[2])!;
          expect(got, `filled (${x}, ${y})`).toEqual(background(nearest[0], nearest[1]));
        } else {
          expect(got, `(${x}, ${y})`).toEqual(background(x, y));
        }
      }
    }
    // Without masks the median alone still removes a mover that covers each pixel in a minority of frames.
    const plain = CleanPlate.median(frames, undefined, w, h);
    const i = (15 * w + 20) * 4;
    expect(Array.from(plain.subarray(i, i + 4))).toEqual(background(20, 15));
  });

  it("clean plate is fast enough", () => {
    const w = 960, h = 540, n = 30;
    const rng = new SplitMix64(52);
    const base = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = rng.next();
      for (let b = 0; b < 4; b++) base[i * 4 + b] = Number((v >> BigInt(8 * b)) & 0xffn);
    }
    const frames = Array.from({ length: n }, (_, k) => {
      const f = new Uint8Array(base.length);
      f.set(base.subarray(k * 4099));
      f.set(base.subarray(0, k * 4099), base.length - k * 4099);
      return f;
    });
    const start = performance.now();
    const plate = CleanPlate.median(frames, undefined, w, h);
    const elapsed = (performance.now() - start) / 1000;
    expect(plate.length).toBe(w * h * 4);
    expect(elapsed, "30 frames of 960 x 540").toBeLessThan(20);
  }, 60_000);

  it("hall lookup and mirroring", () => {
    const cam = Synth.stands;
    const hall = new HallEnvironment();
    expect(hall.halfWidth).toBe(11.5);
    expect(hall.halfLength).toBe(17);
    // The far wall is in the video: its uv is the pixel over the image size, and the 3 x 4 matrix agrees.
    const wall = new V3(-2, 2, -17);
    const px = cam.project(wall)!;
    const uv = hall.uv(wall, cam)!;
    expect(uv.mirrored).toBe(false);
    expectClose(uv.u, px.x / cam.width, 1e-12);
    expectClose(uv.v, px.y / cam.height, 1e-12);
    const m = cam.normalizedProjection;
    const hx = m[0] * wall.x + m[1] * wall.y + m[2] * wall.z + m[3];
    const hy = m[4] * wall.x + m[5] * wall.y + m[6] * wall.z + m[7];
    const hz = m[8] * wall.x + m[9] * wall.y + m[10] * wall.z + m[11];
    expectClose(hx / hz, uv.u, 1e-9);
    expectClose(hy / hz, uv.v, 1e-9);
    // The wall behind the home end line is not in this video: it borrows the far wall, mirrored across Z = 0.
    const behind = new V3(2, 3, 17);
    const seen = cam.project(behind);
    expect(seen ? cam.contains(seen) : false).toBe(false);
    const borrowed = hall.uv(behind, cam)!;
    expect(borrowed.mirrored).toBe(true);
    const far = cam.project(new V3(2, 3, -17))!;
    expectClose(borrowed.u, far.x / cam.width, 1e-12);
    // High above the camera nothing (nor any mirror image) is in the frame.
    expect(hall.uv(new V3(0, 10, 17), cam)).toBeUndefined();
    // A POV ray from mid-court toward the side wall leaves the hall there.
    const exit = hall.exitPoint(new V3(1, 1.8, 3), new V3(1, 0, 0))!;
    expectClose(exit.x, 11.5, 1e-12);
    expect(hall.exitPoint(new V3(0, 1, 30), new V3(0, 0, -1)), "origin outside the hall").toBeUndefined();
  });
});

describe("SceneVideoTests", () => {
  it("frame interpolates facing, posture and ball", () => {
    const track = VideoPlayerTrack.create({ side: "home", label: "4", role: "OH1", samples: [
      VideoPlayerSample.create(0, 0, 3, 3.0, "ready"),
      VideoPlayerSample.create(1, 2, 3, -3.0, "attack", { jump: 0.8, confidence: 0.5 }),
    ] });
    const id = track.id;
    const copy = () => ({ ...track, samples: [...track.samples] });
    const serve = new BallSegment(0.2, 0.6, new V3(0, 3, -9), new V3(0, 2, 15));
    const next = new BallSegment(0.7, 1.2, new V3(0, 2, 2), new V3(1, 3, -5));
    const scene = new VideoScene({ title: "Test", duration: 1.2, camera: Synth.stands, players: [copy()], ball: [serve, next] });
    const f = scene.frame(0.5);
    expect(f.tokens.length).toBe(1);
    expectClose(f.tokens[0].point.x, 1, 1e-12);
    expect(f.tokens[0].label).toBe("4");
    expect(f.tokens[0].posture).toBe("ready");
    // 3.0 to -3.0 radians goes the short way, through pi.
    expectClose(Math.abs(f.yaw.get(id)!), Math.PI, 1e-9);
    expectClose(f.jump.get(id)!, 0.4, 1e-12);
    expect(f.postureBlends.get(id)).toEqual({ from: "ready", to: "attack", t: 0.5 });
    expectClose(f.confidence.get(id)!, 0.75, 1e-12);
    expectClose(f.ball!.z, serve.position(0.5).z, 1e-12);
    // Between two close flights the ball moves straight from one to the other; outside them there is none.
    const gap = scene.frame(0.65).ball!;
    expectClose(gap.y, (serve.position(0.6).y + next.position(0.7).y) / 2, 1e-9);
    expect(scene.frame(0.1).ball).toBeUndefined();
    // Outside its samples a player is absent; the SceneFrame view has the same tokens and no zones.
    scene.players[0].samples.shift();
    expect(scene.frame(0.5).tokens).toEqual([]);
    const sf = new VideoScene({ title: "T", duration: 1, camera: Synth.stands, players: [copy()] }).sceneFrame(0.5);
    expect(sf.tokens.length).toBe(1);
    expect(sf.zones).toEqual([]);
    // As a tap target on the video: the feet below the head, both inside the frame.
    const marker = new VideoScene({ title: "T", duration: 1, camera: Synth.stands, players: [copy()] }).markers(0.5)[0];
    expect(marker).toBeDefined();
    expect(marker.id).toBe(sf.tokens[0].id);
    expect(marker.foot.y).toBeGreaterThan(marker.head.y);
    expect(marker.foot.x >= 0 && marker.foot.x <= 1 && marker.foot.y >= 0 && marker.foot.y <= 1).toBe(true);
    expectClose(sf.tokens[0].yaw!, new VideoScene({ title: "T", duration: 1, camera: Synth.stands, players: [copy()] }).frame(0.5).yaw.get(sf.tokens[0].id)!, 1e-12);
    // Posed with the reconstructed facing and jump.
    const posed = new VideoScene({ title: "T", duration: 1, camera: Synth.stands, players: [copy()] }).frame(1).posedPlayers()[0];
    const s = new SkeletonModel(new BodyMetrics(VideoPlayerTrack.effectiveStature(track)));
    const ankle = Math.min(posed.joints[Joint.lAnkle].translation.y, posed.joints[Joint.rAnkle].translation.y);
    expect(ankle, "feet 0.8 m up").toBeGreaterThan(0.8 + s.ankleHeight - 0.15);
    expect(posed.joints[Joint.head].rotation.rotate(new V3(0, 0, 1)).z, "facing -Z (yaw -3)").toBeLessThan(-0.5);
  });

  it("scene round-trips through JSON", () => {
    const scene = new VideoScene({ title: "Rally 12", createdAt: 1_700_000_000 - referenceDateOffset, duration: 2, camera: Synth.sideline,
      videoFile: "rally12.mov", plateFile: "rally12-plate.png",
      players: [VideoPlayerTrack.create({ side: "opponent", label: "A", samples: [VideoPlayerSample.create(0, 1, -3, 0.2, "block", { jump: 0.5 })] })],
      ball: [new BallSegment(0, 1, new V3(0, 3, -9), new V3(0, 2, 15), { ...Aero.topspin }, 1.2)] });
    const data = JSON.stringify(scene.encode());
    expect(VideoScene.decode(JSON.parse(data))).toEqual(scene);
    const detection = PersonDetection.create({ x: 1, z: 2 }, { x: 3, y: 4 }, { keypoints: { leftWrist: { point: { x: 5, y: 6 }, confidence: 0.7 } },
      boxHeight: 140 });
    const frame: VideoFrameObservation = { time: 0.5, detections: [detection], ball: { x: 7, y: 8 } };
    const json = JSON.stringify(frame);
    expect(json.includes("\"leftWrist\""), "keypoints encode as a dictionary keyed by joint name").toBe(true);
    expect(JSON.parse(json)).toEqual(frame);
  });

  /**
   * Two seconds of a rally: twelve players moving, an opponent float serve received by a home passer, a home middle
   * blocker jumping at the net. The detector is simulated by posing every player and projecting the keypoints with
   * noise (pose at 15 fps, ball at 30 fps); floor points come from the ankles, so they are wrong in the air.
   */
  interface Truth {
    side: Side;
    base: FloorPoint;
    amplitude: [number, number];
    phase: number;
    posture: (t: number) => Posture;
    jump: (t: number) => number;
  }
  const position = (tr: Truth, t: number): FloorPoint => ({
    x: tr.base.x + tr.amplitude[0] * Math.sin(1.7 * t + tr.phase),
    z: tr.base.z + tr.amplitude[1] * Math.sin(1.3 * t + tr.phase * 2),
  });
  const yawOf = (tr: Truth, t: number) => (tr.side === "home" ? Math.PI : 0) + 0.35 * Math.sin(1.1 * t + tr.phase);

  const syntheticRally = (seed: number) => {
    const rng = new SplitMix64(seed);
    const cam = Synth.stands;
    const stature = SceneToken.defaultStature("");
    const skeleton = new SkeletonModel(new BodyMetrics(stature));
    const noJump = () => 0;
    const serveTime = 0.3, receiveTime = 1.5;
    // Home in rotational order P1...P6 (P1 right back, x > 0): P6 receives standing still.
    const homeSpots: FloorPoint[] = [{ x: 3, z: 7 }, { x: 3, z: 1.5 }, { x: 0, z: 2 }, { x: -3, z: 1.5 }, { x: -3, z: 7 }, { x: 0.5, z: 6.5 }];
    const truths: Truth[] = [];
    homeSpots.forEach((b, i) => {
      const receiver = i === 5;
      truths.push({ side: "home", base: b, amplitude: receiver ? [0, 0] : [0.6, 0.5], phase: i,
        posture: (t) => (receiver && t > receiveTime - 0.4 ? "pass" : "ready"), jump: noJump });
    });
    // P3 blocks: in the air from 0.8 to 1.45 s, feet 0.7 m up at the top.
    truths[2] = { side: "home", base: { x: 0.3, z: 0.9 }, amplitude: [0, 0], phase: 2,
      posture: (t) => (t < 0.8 ? "blockReady" : t < 1.45 ? "block" : t < 1.65 ? "blockLanding" : "blockReady"),
      jump: (t) => (t >= 0.8 && t < 1.45 ? 0.7 * Math.sin((Math.PI * (t - 0.8)) / 0.65) : 0) };
    // Opponents mirror the formation; their P1 (right back is -X for them) serves from behind the end line.
    homeSpots.forEach((b, i) => {
      const server = i === 0;
      truths.push({ side: "opponent", base: server ? { x: -2.5, z: -10.2 } : { x: -b.x, z: -b.z }, amplitude: server ? [0, 0] : [0.6, 0.5],
        phase: i + 0.5,
        posture: (t) => (server ? (t < serveTime - 0.15 ? "standing" : t < serveTime + 0.15 ? "floatServe" : "standing") : "ready"),
        jump: noJump });
    });
    // The serve: from the server's hand at contact to the receiver's forearms.
    const serverPose = skeleton.pose("floatServe", position(truths[6], serveTime), yawOf(truths[6], serveTime));
    const receiverPose = skeleton.pose("pass", position(truths[5], receiveTime), yawOf(truths[5], receiveTime));
    const start = maxBy([skeleton.fingertip(serverPose, false), skeleton.fingertip(serverPose, true)], (p) => p.y)!;
    const forearms = receiverPose[Joint.lWrist].translation.add(receiverPose[Joint.rWrist].translation)
      .add(receiverPose[Joint.lElbow].translation).add(receiverPose[Joint.rElbow].translation).mul(0.25);
    const serve = FlightSolver.aim(start, forearms, 16, Aero.float)!;
    expect(serve).toBeDefined();
    const ball = (t: number) => (t >= serveTime && t <= serveTime + serve.duration ? serve.position(t - serveTime) : undefined);

    const frames: VideoFrameObservation[] = [];
    for (let k = 0; k <= 60; k++) {
      const t = k / 30;
      const detections: PersonDetection[] = [];
      if (k % 2 === 0) {
        for (const truth of truths) {
          if (chance(rng, 0.1)) continue;
          const kp = Synth.keypoints(skeleton, truth.posture(t), position(truth, t), yawOf(truth, t), cam, rng,
            { totalJump: truth.posture(t) === "block" ? truth.jump(t) : undefined, noise: 3, drop: 0.1 });
          const d = PersonDetection.fromKeypoints(kp, uniform(rng, 0.6, 1), cam);
          if (d) detections.push(d);
        }
      }
      const b = ball(t), bp = b ? cam.project(b) : undefined;
      const px = bp && cam.contains(bp) ? Synth.noisy(bp, rng, 1.5) : undefined;
      frames.push(px ? { time: t, detections, ball: px } : { time: t, detections });
    }
    const stages: ReconstructionStage[] = [];
    const fractions: number[] = [];
    const scene = VideoReconstructor.reconstruct(frames, cam, { homeLabels: { 6: "L" }, homeRoles: { 6: "L" }, progress: (f, stage) => {
      fractions.push(f);
      if (stages[stages.length - 1] !== stage) stages.push(stage);
    } });
    expect(stages).toEqual(["Tracking players", "Reading body positions", "Tracking the ball", "Done"]);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[fractions.length - 1]).toBe(1);
    expectClose(scene.duration, 2, 1e-9);

    // Players: six a side, labelled by rotational position, where they are, facing the right way.
    expect(scene.players.filter((p) => p.side === "home").length).toBe(6);
    expect(scene.players.filter((p) => p.side === "opponent").length).toBe(6);
    expect(new Set(scene.players.filter((p) => p.side === "home").map((p) => p.label))).toEqual(new Set(["1", "2", "3", "4", "5", "L"]));
    expect(new Set(scene.players.filter((p) => p.side === "opponent").map((p) => p.label))).toEqual(new Set(["A", "B", "C", "D", "E", "F"]));
    const positionErrors: number[] = [], yawErrors: number[] = [];
    for (const track of scene.players) {
      const first = track.samples[0];
      const truthIndex = minBy(truths.map((_, i) => i), (i) => {
        const p = position(truths[i], first.time);
        return Math.hypot(p.x - first.x, p.z - first.z);
      })!;
      const truth = truths[truthIndex];
      if (truthIndex === 5) { expect(track.label).toBe("L"); expect(track.role).toBe("L"); }
      if (truthIndex === 0) expect(track.label).toBe("1");
      if (truthIndex === 6) expect(track.label, "the opponent server is their P1").toBe("A");
      for (const s of track.samples) {
        if (s.occluded) continue;
        const p = position(truth, s.time);
        positionErrors.push(Math.hypot(p.x - s.x, p.z - s.z));
        yawErrors.push(Math.abs(wrappedAngle(s.yaw - yawOf(truth, s.time))));
      }
      if (truthIndex === 5) {
        const late = track.samples[track.samples.length - 1];
        expect(PoseFitter.equivalent(late.posture, "pass"), `the receiver passes: ${late.posture}`).toBe(true);
      }
      if (truthIndex === 2) {
        // The blocker: in the air at the top of the jump, standing where they took off, at the right height.
        const top = minBy(track.samples, (s) => Math.abs(s.time - 1.13))!;
        expect(top.posture).toBe("block");
        expectClose(top.jump, truth.jump(top.time), 0.15, "jump height");
        expect(Math.hypot(top.x - 0.3, top.z - 0.9), "floor point under the jump (1.75 m off uncorrected)").toBeLessThan(0.35);
        for (const s of track.samples) if (s.time < 0.7 || s.time > 1.75) expect(s.jump).toBe(0);
      }
    }
    positionErrors.sort((a, b) => a - b);
    yawErrors.sort((a, b) => a - b);
    expect(positionErrors[Math.floor(positionErrors.length / 2)], "median position error").toBeLessThan(0.15);
    expect(yawErrors[Math.floor(yawErrors.length / 2)], "median facing error").toBeLessThan(deg(20));
    expect(yawErrors[Math.floor((yawErrors.length * 9) / 10)], "90th percentile facing error").toBeLessThan(deg(35));

    // The serve, in 3D, from the server to the receiver.
    expect(scene.ball.length).toBeGreaterThan(0);
    let worst = 0;
    for (const f of frames) {
      if (!f.ball) continue;
      const truth = ball(f.time);
      if (!truth || !(truth.z > 0)) continue;
      const got = scene.frame(f.time).ball;
      expect(got, `ball at ${f.time}`).toBeDefined();
      worst = Math.max(worst, got!.sub(truth).length);
    }
    expect(worst, "ball error in the near half").toBeLessThan(0.3);
    const mid = scene.frame(1.0);
    expect(mid.tokens.length).toBe(12);
    expect(mid.ball).toBeDefined();
    expect(scene.sceneFrame(1.0).tokens.length).toBe(12);
  };

  it("reconstructs a synthetic rally end to end", () => {
    for (const seed of [61, 62, 63, 64, 65, 66]) syntheticRally(seed);
  }, 300_000);
});
