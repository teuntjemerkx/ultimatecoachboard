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
import { BallAnchor, BallReconstruction, BallSegment, defaultBallSettings, type BallObservation } from "./ballReconstruction";
import { CourtCalibration, CourtLandmark, VideoCamera } from "./courtCalibration";
import { CleanPlate, HallEnvironment } from "./environment";
import { PersonDetection, PlayerTracker, type Keypoints, type TrackedPlayer, type VideoFrameObservation } from "./playerTracking";
import { PoseFitter, type PoseTrackFrame, type PoseTrackResult } from "./poseFitting";
import { SplitMix64, Synth, chance, gaussian, shuffled, uniform, unit } from "./testSupport";
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

  it("a tapped jump server keeps his own frames: a second box on him and his jump start no one else", () => {
    // The OK Hoče clip from 4.1 to 6.1 s, on its camera (2.6 m up, 14 m behind our end line), ten pose frames a second.
    // The server, tapped at 0.2 s, stands at z 10.1 with his feet below the frame: his floor points follow what the
    // detector makes of his legs at the bottom edge (z 8.7 to 10.1). At 1.0 s it finds him twice, his box ending 38 px
    // above the edge (z 8.0) and a piece of him in the corner (as at 4.1 s), and at 1.2 s his feet read 30 px above the
    // edge (z 8.3, as at 4.6 s). He jumps at 1.5 s, 0.5 m up for 0.6 s: his feet in the air read up to 3.5 m farther
    // along the view. He lands at z 8.4 and runs in. Two teammates and two opponents stand elsewhere, tapped too.
    // Before, on all 8 seeds a passing track started by the second box took his frame at 1.2 s and a passing track his
    // frames in the air, and on 2 of them his lock followed him up and lost him from the landing on; the same with his
    // first frame in the air missed, as in the clip.
    // Then without the clip's two moments and with the detector's guess at his cut feet from 40 px above the edge to
    // 25 px below it: on 2 of 8 seeds his lock took his first frame in the air at face value (0.1 to 0.3 m up it reads
    // 0.6 to 1.7 m farther, inside its gate), followed him up 3 m into the court and lost him to a passing track at the
    // landing, waiting where he was in the air. Tapped after the jump (2.8 s), his lock followed him back from the
    // landing up and lost him from the take-off back, for a second or more, on all 8 seeds. He is kept from the take-off
    // on (before it, cut feet scattering a metre along the view still split him into his lock and a passing track on
    // one seed). Seeds 20 and 26 tapped after the jump: his lock follows him back from the landing to 2.0 s and takes
    // him again at 1.7 s, his frames between with a passing track, so the gap starts and ends in the air.
    const cam = VideoCamera.lookingAt(new V3(-1.9, 2.6, 23.1), new V3(0.97, 2.16, 0), 360 / Math.tan(deg(10)), 1280, 720);
    const H = cam.height;
    const takeOff = 1.5, landing = 2.1, top = 0.5;
    const lift = (t: number) => (t > takeOff && t < landing ? (4 * top * (t - takeOff) * (landing - t)) / (landing - takeOff) ** 2 : 0);
    const where = (t: number): FloorPoint => (t < takeOff ? { x: -4.4 + 0.3 * t, z: 10.1 }
      : t < landing ? { x: -3.95 + 0.4 * (t - takeOff), z: 10.1 - 2.8 * (t - takeOff) } : { x: -3.71 + 0.3 * (t - landing), z: 8.42 - 2.5 * (t - landing) });
    const posture = (t: number): Posture => (t < takeOff ? "armCock" : t < landing ? "jumpServe" : t < landing + 0.2 ? "landing" : "ready");
    const inPicture = (kp: Keypoints): Keypoints => Object.fromEntries(Object.entries(kp).filter(([, o]) => cam.contains(o!.point)));
    // As the app reads a detector box: the feet from the keypoints, or where the box ends (`footY`, the frame cut him).
    const detect = (kp: Keypoints, footY?: number): PersonDetection => {
      const ys = Object.values(kp).map((o) => o!.point.y), xs = Object.values(kp).map((o) => o!.point.x);
      const y0 = Math.min(...ys) - 0.12 * (Math.max(...ys) - Math.min(...ys)), x = (Math.min(...xs) + Math.max(...xs)) / 2;
      if (footY !== undefined) {
        const foot = { x, y: footY };
        return PersonDetection.create(cam.floorPoint(foot)!, foot, { keypoints: kp, confidence: 0.8, boxHeight: footY - y0 });
      }
      const y1 = Math.min(H, Math.max(...ys) + 4);
      return PersonDetection.fromKeypoints(kp, 0.9, cam, { boxHeight: y1 - y0, boxBottom: { x, y: y1 }, minConfidence: 0.3 })!;
    };
    const others = [{ x: -1, z: 4 }, { x: 2, z: 6.5 }, { x: 0.5, z: -4 }, { x: -2.5, z: -6 }];
    const at = (o: FloorPoint, t: number) => ({ x: o.x + 0.3 * Math.sin(t + o.x), z: o.z });
    const variants = [[true, false, 0.2], [true, true, 0.2], [false, false, 0.2], [false, true, 0.2], [false, false, 2.8], [false, true, 2.8]] as const;
    for (const [clip, missed, tap] of variants) {
      for (const seed of tap > takeOff ? [1, 2, 3, 4, 5, 6, 7, 8, 20, 26] : [1, 2, 3, 4, 5, 6, 7, 8]) {
        const label = `seed ${seed}${clip ? "" : ", scattered feet"}${missed ? ", first frame in the air missed" : ""}${tap > takeOff ? ", tapped after the jump" : ""}`;
        const rng = new SplitMix64(1400 + seed);
        const s = new SkeletonModel(new BodyMetrics(uniform(rng, 1.86, 2.0)));
        const his: PersonDetection[][] = [], theirs: PersonDetection[][][] = [];
        const frames: VideoFrameObservation[] = Array.from({ length: 31 }, (_, k) => {
          const t = k / 10;
          const kp = inPicture(Synth.keypoints(s, posture(t), where(t), Math.PI, cam, rng, { totalJump: lift(t), noise: 2, drop: 0.05 }));
          let mine = [detect(kp, kp.leftAnkle || kp.rightAnkle ? undefined : H + (clip ? uniform(rng, -20, 20) : uniform(rng, -40, 25)))];
          if (clip && k === 10) {
            const whole = detect(kp, H - 38), piece = { x: Math.max(4, whole.footImage.x - 14), y: H - 8 };
            mine = [whole, PersonDetection.create(cam.floorPoint(piece)!, piece, { confidence: 0.12, boxHeight: 75 })];
            expect(PlayerTracker.onePerson(whole, mine[1], cam), label).toBe(true);
          }
          if (clip && k === 12) mine = [detect(kp, H - 30)];
          if (missed && k === 16) mine = [];
          his.push(mine);
          theirs.push(others.map((o) => [detect(inPicture(Synth.keypoints(new SkeletonModel(new BodyMetrics(1.85)), "ready", at(o, t),
            o.z > 0 ? Math.PI : 0, cam, rng, { noise: 2, drop: 0.05 })))]));
          return { time: t, detections: [...mine, ...theirs[k].flat()] };
        });
        const locks = [{ time: tap, foot: his[Math.round(tap * 10)][0].footImage }, ...others.map((o) => ({ time: tap, foot: cam.project(V3.fromFloor(at(o, tap), 0))! }))];
        const { tracks } = new PlayerTracker({ maxFootHeight: 0.4 }).follow(frames, locks, cam);
        tracks[0].samples.forEach((x, k) => {
          if (his[k].length === 0 || (!clip && x.time < takeOff - 1e-6)) return;
          expect(x.measured && his[k].some((d) => d.floor === x.measured), `${label}: his frame at ${x.time.toFixed(1)} s`).toBe(true);
        });
        // The others keep their own.
        others.forEach((_, i) => tracks[i + 1].samples.forEach((x, k) => {
          if (x.measured) expect(theirs[k][i].some((d) => d.floor === x.measured), `${label}: player ${i + 1} at ${x.time.toFixed(1)} s`).toBe(true);
        }));
      }
    }

    // Two people one behind the other are two: a player standing farther away stands higher in the picture, and a short
    // box not cut by the frame is someone else's.
    const tall = PersonDetection.create({ x: -1, z: 6 }, { x: 600, y: 650 }, { boxHeight: 240 });
    const behind = PersonDetection.create({ x: -1, z: 0 }, { x: 610, y: 560 }, { boxHeight: 110 });
    const inside = PersonDetection.create({ x: -1, z: 5.8 }, { x: 590, y: 655 }, { boxHeight: 80 });
    expect(PlayerTracker.onePerson(tall, behind, cam)).toBe(false);
    expect(PlayerTracker.onePerson(tall, inside, cam)).toBe(false);

    // A body lifted 0.3 m stands taller above its feet's farther reading; feet misread 25 px up with the body where it
    // was, or the body standing as far away, do not.
    const rng = new SplitMix64(1499), body = new SkeletonModel(new BodyMetrics(1.9)), spot = { x: -2, z: 6 };
    const pose = (at: FloorPoint, totalJump = 0) => Synth.keypoints(body, "ready", at, Math.PI, cam, rng, { totalJump, noise: 1, drop: 0 });
    const ground = detect(pose(spot)), lifted = detect(pose(spot, 0.3));
    const feetUp = (kp: Keypoints): Keypoints => Object.fromEntries(Object.entries(kp).map(([k, o]) =>
      [k, k.endsWith("Ankle") ? { ...o!, point: { x: o!.point.x, y: o!.point.y - 25 } } : o!]));
    const misread = detect(feetUp(pose(spot)));
    const away = detect(pose({ x: spot.x - 0.15 * (lifted.floor.z - spot.z), z: lifted.floor.z }));
    expect(lifted.floor.z, "the lifted feet read farther").toBeLessThan(spot.z - 1);
    expect(misread.floor.z, "the misread feet read farther").toBeLessThan(spot.z - 1);
    expect(PlayerTracker.lifted(ground, lifted, cam)).toBe(true);
    expect(PlayerTracker.lifted(ground, misread, cam)).toBe(false);
    expect(PlayerTracker.lifted(ground, away, cam)).toBe(false);

    // His legs misread for 0.3 s with the body where it was (the far blocker of the OK Hoče cuts at 1.1 to 1.3 s) are no
    // jump: the passing track that took those readings, beyond his lock's gate, keeps them.
    const blocker = new SkeletonModel(new BodyMetrics(1.9)), stand = { x: 4.3, z: -3 };
    const legs = Array.from({ length: 21 }, (_, k) => {
      const kp = Synth.keypoints(blocker, "ready", stand, 0, cam, rng, { noise: 1, drop: 0 });
      return detect(k >= 11 && k <= 13 ? feetUp(kp) : kp);
    });
    expect(legs[12].floor.z, "the misread legs read farther").toBeLessThan(stand.z - 2);
    const { tracks: [his] } = new PlayerTracker({ maxFootHeight: 0.4 })
      .follow(legs.map((d, k) => ({ time: k / 10, detections: [d] })), [{ time: 0.2, foot: legs[2].footImage }], cam);
    his.samples.forEach((x, k) => expect(x.measured === legs[k].floor, `his lock at ${x.time.toFixed(1)} s`).toBe(k < 11 || k > 13));
  }, 60_000);
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

  it("a jump server near a low camera stands where his size puts him, not his feet", () => {
    // The OK Hoče camera, 2.6 m up behind the end line. The server holds the ball up (armCock, airborne in the library)
    // for 1.5 s with his feet below the frame, then jump-serves: 0.5 m up from 1.6 to 2.2 s, drifting into the court.
    const cam = VideoCamera.lookingAt(new V3(-1.9, 2.6, 23.1), new V3(0.97, 2.16, 0), 360 / Math.tan(deg(10)), 1280, 720);
    const fitter = new PoseFitter(1.95);
    const takeOff = 1.6, landing = 2.2, top = 0.5;
    const lift = (t: number) => (t > takeOff && t < landing ? (4 * top * (t - takeOff) * (landing - t)) / (landing - takeOff) ** 2 : 0);
    const where = (t: number) => ({ x: -3.3 + 0.2 * Math.max(0, t - takeOff), z: t < takeOff ? 9.9 : 9.9 - 2.4 * (t - takeOff) });
    const inPicture = (kp: Keypoints): Keypoints => Object.fromEntries(Object.entries(kp).filter(([, o]) => cam.contains(o!.point)));
    for (let seed = 1; seed <= 8; seed++) {
      const rng = new SplitMix64(1200 + seed);
      const label = `seed ${seed}`;
      // A player of his own size, not the model's.
      const s = new SkeletonModel(new BodyMetrics(uniform(rng, 1.86, 2.0)));
      const frames: PoseTrackFrame[] = strideThrough(0, 2.6, 0.1).map((t) => {
        const posture: Posture = t < takeOff ? "armCock" : t < landing ? "jumpServe" : "landing";
        const kp = inPicture(Synth.keypoints(s, posture, where(t), Math.PI, cam, rng, { totalJump: lift(t), noise: 2, drop: 0.05 }));
        const d = PersonDetection.fromKeypoints(kp, 0.9, cam);
        return { time: t, floor: d?.floor ?? where(t), measured: d?.floor, keypoints: kp };
      });
      const peak = frames.findIndex((f) => Math.abs(f.time - 1.9) < 1e-6);
      const off = (fit: PoseTrackResult, k: number) => Math.hypot(fit.floor[k].x - where(frames[k].time).x, fit.floor[k].z - where(frames[k].time).z);
      // As the clip went: the posture is airborne all along, too long for a take-off-to-landing line, and the jump is
      // measured above a floor point taken from the same feet in the air.
      const before = fitter.fitTrack(frames, cam, Math.PI);
      expect(off(before, peak), `${label}: the feet put him metres into the court`).toBeGreaterThan(2);
      expect(before.estimates[peak].jump, `${label}: no jump`).toBeLessThan(0.15);
      const placed = fitter.placeJumpers(frames, before.estimates, cam);
      expect(placed, label).toBeDefined();
      placed!.forEach((f, k) => {
        if (lift(f.time) === 0) expect(f.placed, `${label}: ${f.time.toFixed(1)} s, on the floor, keeps its feet`).toBeUndefined();
      });
      const after = fitter.fitTrack(placed!, cam, Math.PI);
      frames.forEach((f, k) => {
        if (lift(f.time) === 0) return;
        expect(off(after, k), `${label}: ${f.time.toFixed(1)} s where he is`).toBeLessThan(0.7);
        expectClose(after.estimates[k].jump, lift(f.time), 0.15, `${label}: ${f.time.toFixed(1)} s jump`);
      });
    }

    // Players standing in an airborne posture (arms up at the net, an attack read on a standing player) are not moved:
    // only feet the size puts well above the floor are. Players of 1.80 to 2.05 m, on any camera.
    let moved = 0, tried = 0;
    const rng = new SplitMix64(1300);
    for (const camera of [cam, Synth.tripod, Synth.stands]) {
      for (let i = 0; i < 60; i++) {
        const s = new SkeletonModel(new BodyMetrics(uniform(rng, 1.8, 2.05)));
        const posture: Posture = (["block", "attack", "jumpServe", "armCock"] as const)[i % 4];
        const at = { x: uniform(rng, -4, 4), z: uniform(rng, -8, 9) };
        const kp = Synth.keypoints(s, posture, at, uniform(rng, -Math.PI, Math.PI), camera, rng, { totalJump: 0, noise: 2, drop: 0.05 });
        const d = PersonDetection.fromKeypoints(kp, 0.9, camera);
        const e = d && fitter.fit(kp, d.floor, camera);
        if (!d || !e || !fitter.isAirborne(e.posture)) continue;
        tried += 1;
        if (fitter.placeJumper(e.posture, e.yaw, kp, d.floor, camera)) moved += 1;
      }
    }
    expect(tried).toBeGreaterThan(100);
    expect(moved, `standing players moved, of ${tried}`).toBe(0);
  }, 60_000);

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

  /**
   * Web addition: a far broadcast camera (a telephoto behind the home end, as on the Tokyo clip) sees a short falling
   * ball almost along its viewing ray, and the free fit often starts it at the camera or behind the far end. Such a
   * flight is dropped without an anchor; with a hand anchor it is refitted inside the hall at a believable speed.
   */
  it("drops or pins a flight a far camera cannot place", () => {
    const cam = VideoCamera.lookingAt(new V3(0, 9.4, 38.9), new V3(0, 0, -4.8), 1743, 600, 338);
    const flights: [string, SyntheticFlight][] = [
      ["set coming down", new SyntheticFlight(new V3(-3, 3.6, -1), new V3(0.6, -0.5, -0.3), Aero.soft, 0.25)],
      ["ball dropping at the far end", new SyntheticFlight(new V3(-1.5, 4, -4), new V3(0.5, 0, 1), Aero.soft, 0.3)],
    ];
    let unplaced = 0, pinned = 0;
    for (const [name, flight] of flights) {
      for (let seed = 1; seed <= 12; seed++) {
        const rng = new SplitMix64(500 + seed);
        const obs = observe(flight.position, 0, flight.duration, 30, unit(rng), cam, rng);
        const label = `${name}, seed ${seed}`;
        expect(obs.length, label).toBeGreaterThan(6);
        // Unanchored: only believable flights come out.
        const free = BallReconstruction.fit(obs, cam)!;
        const alone = BallReconstruction.reconstruct([obs], cam);
        if (!BallReconstruction.plausible(free)) {
          unplaced += 1;
          expect(alone.length, `${label}: dropped`).toBe(0);
        }
        for (const s of alone) expect(BallReconstruction.plausible(s), label).toBe(true);
        // A hand at the end (to +-0.2 m) pins one point; the refit keeps the slowest flight that fits.
        const end = obs[obs.length - 1].time, p = flight.position(end);
        const hand = BallAnchor.hand(end, new V3(p.x + uniform(rng, -0.2, 0.2), p.y + uniform(rng, -0.2, 0.2), p.z + uniform(rng, -0.2, 0.2)));
        const anchored = BallReconstruction.fit(obs, cam, [hand])!;
        const segments = BallReconstruction.reconstruct([obs], cam, [hand]);
        expect(segments.length, label).toBe(1);
        const seg = segments[0];
        expect(BallReconstruction.plausible(seg), label).toBe(true);
        if (BallReconstruction.plausible(anchored)) continue;
        pinned += 1;
        expect(seg.rmsError, `${label}: reprojects`).toBeLessThan(2);
        let worst = 0;
        for (const o of obs) worst = Math.max(worst, seg.position(o.time).sub(flight.position(o.time)).length);
        expect(worst, `${label}: pinned near the flight`).toBeLessThan(0.5);
      }
    }
    // The failure this guards against happens on most seeds.
    expect(unplaced).toBeGreaterThan(8);
    expect(pinned).toBeGreaterThan(4);
  }, 60_000);

  /**
   * Web addition: a low camera 14 m behind the home end line (as on a club's tripod) places a hard serve going away
   * from it well, but its free fit can still come out over the top speed: it is capped, not dropped. A ball that stays
   * on the floor (how a ball held or bounced by the server reads from there) is no flight and is dropped.
   */
  it("caps a serve from a low camera and drops a ball on the floor", () => {
    const cam = VideoCamera.lookingAt(new V3(-1.9, 2.6, 23.1), new V3(0.97, 2.16, 0), 360 / Math.tan(deg(10)), 1280, 720);
    const from = new V3(-2.8, 3, 10);
    const serve = new SyntheticFlight(from, SyntheticFlight.aim(from, new V3(-1, 2.4, -4), 34, 0.03), Aero.float, 0.57);
    let capped = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = new SplitMix64(700 + seed);
      const obs = observe(serve.position, 0, serve.duration, 25, unit(rng), cam, rng);
      const label = `serve, seed ${seed}`;
      const free = BallReconstruction.fit(obs, cam)!;
      const segments = BallReconstruction.reconstruct([obs], cam);
      expect(segments.length, label).toBe(1);
      const seg = segments[0];
      expect(BallReconstruction.plausible(seg), label).toBe(true);
      expect(seg.rmsError, `${label}: reprojects`).toBeLessThan(2);
      // A believable free fit is kept as it is; one over the top speed is refitted below it, and is the better for it.
      if (!(free.v0.length > defaultBallSettings.maxSpeed)) continue;
      capped += 1;
      let worst = 0, freeWorst = 0;
      for (const o of obs) {
        worst = Math.max(worst, seg.position(o.time).sub(serve.position(o.time)).length);
        freeWorst = Math.max(freeWorst, free.position(o.time).sub(serve.position(o.time)).length);
      }
      expect(seg.v0.length, label).toBeLessThanOrEqual(defaultBallSettings.maxSpeed);
      expect(worst, `${label}: near the serve`).toBeLessThan(Math.min(0.75, freeWorst));
    }
    expect(capped, "free fits over the top speed").toBeGreaterThan(2);

    for (let seed = 1; seed <= 6; seed++) {
      const rng = new SplitMix64(800 + seed);
      const rolling = (t: number) => new V3(-0.8 + 0.6 * t, BallFlight.radius, 6.8 - 2.5 * t);
      const obs = observe(rolling, 0, 0.25, 30, unit(rng), cam, rng);
      expect(BallReconstruction.reconstruct([obs], cam).length, `rolling ball, seed ${seed}`).toBe(0);
    }
  }, 60_000);

  /**
   * Web addition: a club's camera 2.2 m up and 14 m behind our end line (the Orion clip) sees a ball come off the block
   * at the net and land behind our end line nearly along its viewing rays, and the pixels alone often place it metres
   * nearer the camera, slower. The ball's size in the picture (the detector's box, here good to 15%) says how far it is.
   * And the clip's false flight, a far player's head standing still and then a knee pad below it, fits the pixels as a
   * ball flying at the camera at over 30 m/s: there the ball would look many times larger than the head did.
   */
  it("places a flight by the ball's size, and a head is no ball flying at the camera", () => {
    const cam = CourtCalibration.solveNearHalf([{ x: 1213, y: 632 }, { x: 30, y: 632 }], [{ x: 420, y: 448 }, { x: 848, y: 448 }],
      "home", 1280, 720)!.camera;
    const size = (p: V3) => (cam.focalLength * 2 * BallFlight.radius) / p.sub(cam.center).length;
    const from = new V3(2, 3, 0.3), to = new V3(-1, 0.1, 10.2), duration = 0.67;
    const deflection = new SyntheticFlight(from, new V3((to.x - from.x) / duration,
      (to.y - from.y + 0.5 * BallFlight.gravity * duration * duration) / duration, (to.z - from.z) / duration), Aero.soft, duration);
    let lost = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = new SplitMix64(900 + seed);
      // Seen from a quarter of a second after the block, at 24 frames a second, as on the clip.
      const obs = observe(deflection.position, 0.25, 0.6, 24, unit(rng), cam, rng)
        .map((o) => ({ ...o, size: size(deflection.position(o.time)) * Math.exp(0.15 * gaussian(rng)) }));
      const worst = (sized: boolean) => {
        const segments = BallReconstruction.reconstruct([sized ? obs : obs.map(({ time, image }) => ({ time, image }))], cam);
        expect(segments.length, `seed ${seed}`).toBe(1);
        return Math.max(...obs.map((o) => segments[0].position(o.time).sub(deflection.position(o.time)).length));
      };
      if (worst(false) > 1.5) lost += 1;
      expect(worst(true), `seed ${seed}: placed by its size`).toBeLessThan(1);
    }
    expect(lost, "pixels alone more than 1.5 m off").toBeGreaterThan(2);

    // The head and the knee pad (read times and pixels from the clip, the box sizes from a build).
    const head = [[7.867, 533, 377, 12.5], [7.9, 533, 378, 13.5], [7.933, 535, 378, 10], [7.967, 535, 378, 9], [8.033, 532, 418, 10]];
    const plain = BallReconstruction.reconstruct([head.map(([time, x, y]) => ({ time, image: { x, y } }))], cam);
    expect(plain.length).toBe(1);
    expect(plain[0].v0.length).toBeGreaterThan(30);
    expect(plain[0].position(plain[0].t1).sub(cam.center).length).toBeLessThan(1.5);
    expect(BallReconstruction.reconstruct([head.map(([time, x, y, s]) => ({ time, image: { x, y }, size: s }))], cam)).toEqual([]);
  }, 60_000);

  /**
   * Web addition: on the OK Hoče clip (a tripod 2.6 m up, 14 m behind our end line) the ball's size places a ball held
   * by the server near the camera, and the ball at the top of his toss, well enough to look believable, but neither
   * moves in the picture, so the fit makes them balls flying along the view at 24 and 18 m/s. The image must fix a
   * flight's speed too (`placedSpeed`); the serve that follows keeps its flight.
   */
  it("a ball held or at the top of a toss near a low camera is no flight", () => {
    const cam = CourtCalibration.solveNearHalf([{ x: 13, y: 695 }, { x: 1272, y: 692 }], [{ x: 943, y: 550 }, { x: 164, y: 550 }],
      "home", 1280, 720)!.camera;
    // Read times, pixels and box sizes (0: cut by the frame's edge) from a build of the clip.
    const held = [[1.233, 21.8, 568.3, 0], [1.3, 24.3, 568.8, 41.5], [1.333, 24.5, 569.5, 43], [1.367, 24.5, 572.3, 0], [1.4, 27.8, 575.3, 37.5]];
    const tossTop = [[5.633, 189, 291, 28], [5.7, 190, 288, 27], [5.733, 194.5, 287.5, 25], [5.767, 198.3, 287.8, 20.5], [5.8, 199.3, 287, 20]];
    const serve = [[5.9, 263, 263, 28], [5.933, 290.5, 253.5, 28], [5.967, 315, 245.8, 27.5], [6, 336, 239.3, 25.5], [6.067, 371.8, 233.5, 26],
      [6.133, 386.5, 233.3, 25.5], [6.167, 401.3, 236.3, 20.5], [6.2, 410, 238.3, 22], [6.233, 421, 242.5, 20], [6.3, 428.5, 246.3, 18],
      [6.333, 438, 252, 18], [6.367, 444.3, 259, 16], [6.4, 450, 264.3, 16.5], [6.467, 456, 270.8, 19.5], [6.5, 461.3, 281.8, 17.5]];
    const obs = (points: number[][]): BallObservation[] =>
      points.map(([time, x, y, size]) => (size > 0 ? { time, image: { x, y }, size } : { time, image: { x, y } }));
    for (const [name, points] of [["held", held], ["toss top", tossTop]] as const) {
      const loose = BallReconstruction.reconstruct([obs(points)], cam, [], { placedSpeed: Infinity });
      expect(loose.length, `${name}: believable without the speed check`).toBe(1);
      expect(BallReconstruction.plausible(loose[0]), name).toBe(true);
      expect(BallReconstruction.reconstruct([obs(points)], cam), name).toEqual([]);
    }
    const flights = BallReconstruction.reconstruct([obs(serve)], cam);
    expect(flights.length).toBe(1);
    expect(flights[0].v0.length).toBeLessThanOrEqual(defaultBallSettings.maxSpeed);
    expect(flights[0].position(5.9).sub(new V3(-2.8, 2.9, 10.1)).length, "from the server").toBeLessThan(0.5);
  }, 60_000);

  /**
   * Web addition: the OK Hoče float serve, from the build of the clip's clean 25 fps copy: the detector's points to
   * 6.16 s (with their box sizes), the far ball `followBall` finds from 6.20 s, and two points after the reception
   * (at about 6.72 s, the receiver at their end line). It slows more than the model's C_D of 0.25 lets it: grown
   * drag-free it is cut in two at 6.28 s, fitted drag-free as one it flies on 9 m past the receiver. Grown and fitted
   * with its drag coefficient free it is one flight up to the reception, at about 26 m/s off the hand (the frames say
   * about 24), and reaches the receiver within 2 m.
   */
  it("a float serve that slows more than the model's drag is one flight", () => {
    const cam = CourtCalibration.solveNearHalf([{ x: 13, y: 695 }, { x: 1272, y: 692 }], [{ x: 943, y: 550 }, { x: 164, y: 550 }],
      "home", 1280, 720)!.camera;
    // Times on the clean copy's frame grid, pixels and box sizes (0: a followed point, which has none).
    const serve = [[5.517, 232.8, 275.5, 30], [5.557, 263, 263, 28], [5.597, 290.5, 253.5, 28], [5.637, 315, 245.8, 28.5],
      [5.677, 336, 239.3, 25.5], [5.757, 372, 233.8, 26.5], [5.797, 386.3, 233.3, 25.5], [5.837, 401.3, 236.3, 20.5],
      [5.877, 410.3, 238.3, 22.5], [5.917, 421, 242.5, 20], [5.957, 429, 246.3, 18], [5.997, 437.8, 251.8, 18.5],
      [6.037, 444, 258.5, 16], [6.077, 449.8, 264.3, 18.5], [6.117, 455.8, 270.8, 19.5], [6.157, 461.5, 281.8, 17.5],
      [6.197, 467.5, 288.5, 0], [6.237, 470.6, 301.6, 0], [6.277, 475, 308.4, 0], [6.437, 493.4, 354.1, 0], [6.477, 496.8, 365.4, 0],
      [6.517, 504.4, 379.2, 0], [6.557, 506.6, 395.5, 0], [6.597, 509.8, 407.6, 0], [6.677, 516.8, 434.9, 0], [6.717, 521.1, 444.4, 0],
      [6.757, 521.5, 452, 0], [6.797, 525.9, 465.3, 0]];
    const obs: BallObservation[] = serve.map(([time, x, y, size]) => (size > 0 ? { time, image: { x, y }, size } : { time, image: { x, y } }));
    const reception = { time: 6.717, at: new V3(0.1, 0.7, -9.5) };
    const dragFree = BallReconstruction.split(obs, cam, { drag: false });
    expect(dragFree.length, "grown drag-free").toBe(2);
    expect(dragFree[0][dragFree[0].length - 1].time).toBeCloseTo(6.277, 3);
    const groups = BallReconstruction.split(obs, cam);
    expect(groups.length).toBe(1);
    expect([groups[0][0].time, groups[0][groups[0].length - 1].time], "up to the reception").toEqual([5.517, reception.time]);
    const flights = BallReconstruction.reconstruct(groups, cam);
    expect(flights.length).toBe(1);
    const serveFlight = flights[0];
    expect(serveFlight.aero.drag).toBeGreaterThan(0.4);
    expect(serveFlight.velocity(serveFlight.t0).length, "off the hand").toBeGreaterThan(22);
    expect(serveFlight.velocity(serveFlight.t0).length, "off the hand").toBeLessThan(28);
    expect(serveFlight.velocity(serveFlight.t1).length, "at the reception").toBeLessThan(15);
    expect(serveFlight.position(reception.time).sub(reception.at).length, "at the receiver").toBeLessThan(2);
    const plain = BallReconstruction.reconstruct(groups, cam, [], { drag: false });
    expect(plain.length).toBe(1);
    expect(plain[0].position(reception.time).sub(reception.at).length, "drag-free, past the receiver").toBeGreaterThan(5);
  }, 60_000);

  /**
   * Web addition: a float serve whose C_D is 0.5 (a ball below its drag crisis), seen at 25 frames a second with about
   * a pixel of noise by a low camera behind our end line. Where the image shows the drag (`dragSeen`: half the seeds)
   * it is fitted and the flight placed to a metre; elsewhere the model's 0.25 fits the pixels nearly as well with the
   * ball about 2 m off along the view, and drag-free it is 6 m off. A serve with the model's 0.25 keeps it (`unanchored
   * float flight`).
   */
  it("fits a float serve's drag where the image shows it", () => {
    const cam = VideoCamera.lookingAt(new V3(-1.9, 2.6, 23.1), new V3(0.97, 2.16, 0), 360 / Math.tan(deg(10)), 1280, 720);
    const aero: Aero = { drag: 0.5, lift: 0 };
    const from = new V3(-3, 2.9, 9.3);
    // 24 m/s at 10 degrees up, toward a receiver at (0, 0.7, -9.5).
    const heading = new V3(3, 0, -18.8).normalized, up = deg(10);
    const serve = new SyntheticFlight(from, heading.mul(24 * Math.cos(up)).add(V3.up.mul(24 * Math.sin(up))), aero, 1.19);
    expect(serve.position(serve.duration).sub(new V3(0, 0.7, -9.5)).length).toBeLessThan(0.3);
    let seen = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const rng = new SplitMix64(1100 + seed);
      const obs = observe(serve.position, 0, serve.duration, 25, unit(rng), cam, rng);
      const label = `seed ${seed}`;
      const segments = BallReconstruction.segment(obs, cam);
      expect(segments.length, label).toBe(1);
      const worst = (s: BallSegment) => Math.max(...obs.map((o) => s.position(o.time).sub(serve.position(o.time)).length));
      if (segments[0].aero.drag !== Aero.float.drag) {
        seen += 1;
        expect(segments[0].aero.drag, label).toBeGreaterThan(0.35);
        expect(worst(segments[0]), `${label}: placed`).toBeLessThan(1);
      } else {
        expect(worst(segments[0]), `${label}: the model's drag`).toBeLessThan(2.5);
      }
      expect(worst(BallReconstruction.reconstruct([obs], cam, [], { drag: false })[0]), `${label}: drag-free`).toBeGreaterThan(5);
    }
    expect(seen, "drag seen").toBeGreaterThanOrEqual(3);
  }, 60_000);

  /**
   * Web addition: the far broadcast camera of the Tokyo clip sees an opponent pass the ball at the far side along a
   * viewing ray that also runs through the raised hands of a home player more than 5 m nearer the camera. That hand is
   * nearer the ray than the passer's forearms, and the nearest hand was the contact; now the contact is the passer's
   * or there is none.
   */
  it("a far camera's contact is the player at the ball, or none", () => {
    const cam = VideoCamera.lookingAt(new V3(0, 9.4, 38.9), new V3(0, 0, -4.8), 1743, 600, 338);
    const t0 = 1;
    const track = (side: Side, label: string, at: FloorPoint, yaw: number, posture: Posture) => VideoPlayerTrack.create({ side, label,
      stature: 1.9, samples: [VideoPlayerSample.create(0, at.x, at.z, yaw, posture), VideoPlayerSample.create(3, at.x, at.z, yaw, posture)] });
    const sceneOf = (players: VideoPlayerTrack[]) => new VideoScene({ title: "Far contact", duration: 3, camera: cam, players });
    // Distance of a player's nearest hand point (as `contactAnchor` takes them) from a ray.
    const handDistance = (scene: VideoScene, ray: { origin: V3; direction: V3 }) => {
      const j = scene.frame(t0).posedPlayers()[0].joints, s = new SkeletonModel(new BodyMetrics(1.9));
      const wrists = [j[Joint.lWrist].translation, j[Joint.rWrist].translation];
      const elbows = [j[Joint.lElbow].translation, j[Joint.rElbow].translation];
      const hands = [s.fingertip(j, true), s.fingertip(j, false), ...wrists, ...elbows.map((e, i) => e.add(wrists[i]).mul(0.5))];
      return Math.min(...hands.map((q) => {
        const w = q.sub(ray.origin);
        return w.sub(ray.direction.mul(w.dot(ray.direction))).length;
      }));
    };
    for (let seed = 1; seed <= 8; seed++) {
      const rng = new SplitMix64(700 + seed);
      const label = `seed ${seed}`;
      // The passer, facing the net: the ball leaves a little above the forearms, rising toward the net.
      const passerAt = { x: uniform(rng, -2.5, 2.5), z: uniform(rng, -7, -5) };
      const passer = track("opponent", "A", passerAt, 0, "pass");
      const pj = sceneOf([passer]).frame(t0).posedPlayers()[0].joints;
      const forearms = pj[Joint.lWrist].translation.add(pj[Joint.rWrist].translation).add(pj[Joint.lElbow].translation)
        .add(pj[Joint.rElbow].translation).mul(0.25);
      const contact = forearms.add(new V3(0, 0.22, 0));
      const flight = new SyntheticFlight(contact, new V3(uniform(rng, -1, 1), uniform(rng, 6, 7.5), uniform(rng, 2, 3.5)), Aero.soft, 0.7);
      const obs = observe((t) => flight.position(t - t0), t0, t0 + flight.duration, 30, unit(rng), cam, rng);
      expect(obs.length, label).toBeGreaterThan(15);
      // Where the track only breaks (a lost point, a gap) the ball flies on, and that is no contact.
      expect(VideoReconstructor.fliesOn(obs.slice(0, 8), obs, cam, false), `${label}: flies on`).toBe(true);
      expect(VideoReconstructor.fliesOn(obs.slice(9), obs, cam, true), `${label}: flies on`).toBe(true);
      expect(VideoReconstructor.fliesOn(obs, obs, cam, true), `${label}: nothing before the pass`).toBe(false);
      // A home player with the hands up, placed so that a fingertip is on the ray through the ball at the contact.
      const ray = cam.ray(cam.project(contact)!);
      const probe = sceneOf([track("home", "3", { x: 0, z: 0 }, Math.PI, "block")]).frame(t0).posedPlayers()[0];
      const tip = maxBy([probe.skeleton.fingertip(probe.joints, true), probe.skeleton.fingertip(probe.joints, false)], (p) => p.y)!;
      const onRay = ray.origin.add(ray.direction.mul((tip.y - ray.origin.y) / ray.direction.y));
      const rival = track("home", "3", { x: onRay.x - tip.x, z: onRay.z - tip.z }, Math.PI, "block");
      expect(onRay.z - tip.z, `${label}: the rival stands on the home side`).toBeGreaterThan(0);
      expect(onRay.sub(contact).length, `${label}: metres apart along the ray`).toBeGreaterThan(5);
      const dRival = handDistance(sceneOf([rival]), ray), dPasser = handDistance(sceneOf([passer]), ray);
      expect(dRival, label).toBeLessThan(0.05);
      expect(dPasser, `${label}: the rival's hand is the nearer`).toBeGreaterThan(dRival + 0.1);
      // Alone, the passer is the contact.
      const alone = VideoReconstructor.contactAnchor(obs, sceneOf([passer]), true, undefined, obs);
      expect(alone, `${label}: the passer alone`).toBeDefined();
      expect(alone!.position.sub(contact).length, `${label}: at the passer`).toBeLessThan(0.5);
      // With the rival on the ray: the passer or none.
      const both = VideoReconstructor.contactAnchor(obs, sceneOf([passer, rival]), true, undefined, obs);
      if (both) expect(both.position.sub(contact).length, `${label}: at the passer, not the rival`).toBeLessThan(0.5);
    }
  }, 60_000);

  /**
   * Web addition: the OK Hoče server jump-serves near the camera (2.6 m up, 14 m behind our end line). His feet were
   * below the frame until he took off, so nothing showed the jump, and his feet in the air read as a floor point about
   * 3 m into the court; his hand there was near the serve's ray and became the contact, and the serve fitted through
   * it was dropped (its sizes did not fit). The ball's size places a near contact to about half a metre: a hand that
   * far along the ray is no contact, the hand at the ball is.
   */
  it("a jump server read metres into the court is no contact", () => {
    const cam = VideoCamera.lookingAt(new V3(-1.9, 2.6, 23.1), new V3(0.97, 2.16, 0), 360 / Math.tan(deg(10)), 1280, 720);
    const size = (p: V3) => (cam.focalLength * 2 * BallFlight.radius) / p.sub(cam.center).length;
    const t0 = 1, settings = defaultBallSettings;
    const sceneOf = (at: FloorPoint, jump: number) => new VideoScene({ title: "Jump serve", duration: 3, camera: cam,
      players: [VideoPlayerTrack.create({ side: "home", label: "1", stature: 1.9, samples: [0, 3].map((t) =>
        VideoPlayerSample.create(t, at.x, at.z, Math.PI, "jumpServe", { jump })) })] });
    const fingertip = (scene: VideoScene) => {
      const p = scene.frame(t0).posedPlayers()[0];
      return maxBy([p.skeleton.fingertip(p.joints, true), p.skeleton.fingertip(p.joints, false)], (q) => q.y)!;
    };
    let oldRule = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const rng = new SplitMix64(1100 + seed);
      const label = `seed ${seed}`;
      // In the air behind the end line, the ball just above his hand, served over the net at 24 to 30 m/s.
      const at = { x: uniform(rng, -3.5, -2.5), z: uniform(rng, 9.3, 10) };
      const where = sceneOf(at, 0.5);
      const contact = fingertip(where).add(new V3(0, 0.1, -0.1));
      const serve = new SyntheticFlight(contact, SyntheticFlight.aim(contact, new V3(uniform(rng, -2, 0), 2.4, -4), uniform(rng, 24, 30), 0.03),
        Aero.float, 0.65);
      const obs = observe((t) => serve.position(t - t0), t0 + 0.04, t0 + serve.duration, 25, unit(rng), cam, rng)
        .map((o) => ({ ...o, size: size(serve.position(o.time - t0)) * Math.exp(0.1 * gaussian(rng)) }));
      const found = VideoReconstructor.contactAnchor(obs, where, true, undefined, obs);
      expect(found, `${label}: where he is`).toBeDefined();
      expect(found!.position.sub(contact).length, `${label}: at the ball`).toBeLessThan(0.5);
      // Misread: his hand on the same ray 3 m farther along it.
      const ray = cam.ray(cam.project(contact)!);
      const far = ray.origin.add(ray.direction.mul(contact.sub(ray.origin).length + 3));
      const tip = fingertip(sceneOf({ x: 0, z: 0 }, 0.5));
      const misread = sceneOf({ x: far.x - tip.x, z: far.z - tip.z }, 0.5 + far.y - tip.y);
      expect(VideoReconstructor.contactAnchor(obs, misread, true, undefined, obs), `${label}: misread`).toBeUndefined();
      // The checks before this one would have taken that hand on most seeds: a believable flight through it reprojects.
      const wrong = BallAnchor.hand(t0, far, 0.3);
      expect(VideoReconstructor.imagePlaces(wrong, obs, cam), label).toBe(false);
      const through = BallReconstruction.bestFit(obs, cam, [wrong], settings.drag, settings)!;
      if (Math.sqrt(through.pixelCost / through.count) <= settings.rmsThreshold
        && Math.sqrt(through.sizeCost / through.sizeCount) <= settings.sizeThreshold) oldRule += 1;
    }
    expect(oldRule, "misread hands the image alone accepted").toBeGreaterThan(4);

    // The clip's own toss and serve (a clean 25 fps copy: frame times, pixels and box sizes from a build) and the
    // build's three hand anchors: the toss's start, and its end and the serve's start at the hand 3 m into the court.
    const clip = VideoCamera.decode({ focalLength: 2016.07, width: 1280, height: 720,
      rotation: { x: 0.998115, y: 0.008468, z: 0.06008, w: -0.009192 }, center: { x: -1.94, y: 2.609, z: 23.131 } });
    const points = (rows: number[][]): BallObservation[] => rows.map(([time, x, y, s]) => ({ time, image: { x, y }, size: s }));
    const toss = points([[5.317, 189, 291.3, 28], [5.357, 190.3, 288, 27], [5.397, 194, 287.5, 26], [5.437, 198.8, 288, 20.5],
      [5.477, 199.3, 287.8, 21.5]]);
    const serve = points([[5.517, 232.8, 275.5, 30], [5.557, 263, 263, 28], [5.597, 290.5, 253.5, 28], [5.637, 315, 245.8, 28.5],
      [5.677, 336, 239.3, 25.5], [5.757, 372, 233.8, 26.5], [5.797, 386.3, 233.3, 25.5], [5.837, 401.3, 236.3, 20.5],
      [5.877, 410.3, 238.3, 22.5], [5.917, 421, 242.5, 20], [5.957, 429, 246.3, 18], [5.997, 437.8, 251.8, 18.5],
      [6.037, 444, 258.5, 16], [6.077, 449.8, 264.3, 18.5], [6.117, 455.8, 270.8, 19.5], [6.157, 461.5, 281.8, 17.5]]);
    const topspin = BallReconstruction.expectedAero("attack");
    const tossStart = BallAnchor.hand(5.257, new V3(-3.5, 2.7, 7.6), 0.3, topspin);
    const tossEnd = BallAnchor.hand(5.537, new V3(-3.5, 2.8, 6.2), 0.3);
    const serveStart = BallAnchor.hand(5.485, new V3(-3.5, 2.8, 6.5), 0.3, topspin);
    const isServe = (s: BallSegment) => s.t1 > 6;
    // Without the rule the build's anchors spoil the serve: dropped (its sizes over the threshold), or, with the drag
    // coefficient fitted (dragSeen), kept from the misread hand 3 m into the court.
    const before = BallReconstruction.reconstruct([toss, serve], clip, [tossStart, tossEnd, serveStart]).find(isServe);
    expect(before === undefined || before.position(5.517).z < 8.5, "before").toBe(true);
    expect(VideoReconstructor.imagePlaces(serveStart, serve, clip)).toBe(false);
    expect(VideoReconstructor.imagePlaces(tossEnd, toss, clip), "the toss alone does not place its end").toBe(true);
    const agreed = VideoReconstructor.agreedAnchors([tossStart, tossEnd, serveStart], [toss, serve], clip);
    expect(agreed, "the serve's image puts the toss's end elsewhere too").toEqual([tossStart]);
    const flight = BallReconstruction.reconstruct([toss, serve], clip, agreed).find(isServe);
    expect(flight).toBeDefined();
    expect(flight!.v0.length).toBeLessThanOrEqual(settings.maxSpeed);
    expect(flight!.position(5.517).z, "from behind the end line").toBeGreaterThan(8.5);
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
