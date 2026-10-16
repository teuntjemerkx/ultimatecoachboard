// Port of Video/BallReconstruction.swift: monocular ball reconstruction (Section 4.4).
import type { FloorPoint } from "../match/court";
import { Aero, BallFlight } from "../spatial/ballFlight";
import { V3 } from "../spatial/math3d";
import type { Posture } from "../spatial/skeleton";
import type { VideoCamera } from "./courtCalibration";
import { ImagePoint, LevenbergMarquardt, LinearAlgebra } from "./videoMath";

/** The ball's pixel in one frame. */
export interface BallObservation {
  time: number;
  image: ImagePoint;
}

/** The Swift Codable shape of a ball segment. */
export interface BallSegmentJSON {
  t0: number;
  t1: number;
  p0: { x: number; y: number; z: number };
  v0: { x: number; y: number; z: number };
  aero: Aero;
  rmsError: number;
}

/** One free flight of the ball between contacts, reconstructed in 3D. */
export class BallSegment {
  /** Drag and lift both 0: the drag-free parabola. */
  static readonly vacuum: Readonly<Aero> = { drag: 0, lift: 0 };

  constructor(
    /** Start and end of the flight (contact times, or the first and last observation), seconds. */
    public t0: number,
    public t1: number,
    /** Position and velocity at t0. */
    public p0: V3,
    public v0: V3,
    /** Drag and lift; `BallSegment.vacuum` is the drag-free parabola. */
    public aero: Aero = { ...BallSegment.vacuum },
    /** Reprojection error of the fit, pixels RMS. */
    public rmsError = 0,
  ) {}

  get isBallistic(): boolean {
    return this.aero.drag === 0 && this.aero.lift === 0;
  }

  /** Ball centre at time t (extrapolated outside t0...t1), never below the floor. */
  position(t: number): V3 {
    const p = BallSegment.positions(this.p0, this.v0, this.aero, [t - this.t0])[0];
    return p.with({ y: Math.max(p.y, BallFlight.radius) });
  }

  /** The trajectory at time t without the floor clamp. */
  unclamped(t: number): V3 {
    return BallSegment.positions(this.p0, this.v0, this.aero, [t - this.t0])[0];
  }

  /** Velocity at time t (central difference of the trajectory). */
  velocity(t: number): V3 {
    const h = 1e-4;
    const p = BallSegment.positions(this.p0, this.v0, this.aero, [t - this.t0 - h, t - this.t0 + h]);
    return p[1].sub(p[0]).mul(1 / (2 * h));
  }

  /**
   * Positions at flight times (relative to the start, in any order and sign) by the closed form when drag-free, else
   * RK4 on the core's BallFlight model with steps of at most `dt`, ending exactly on every time.
   */
  static positions(p0: V3, v0: V3, aero: Aero, times: readonly number[], dt = 0.004): V3[] {
    const g = BallFlight.gravity;
    if (aero.drag === 0 && aero.lift === 0) {
      return times.map((t) => new V3(p0.x + v0.x * t, p0.y + v0.y * t - 0.5 * g * t * t, p0.z + v0.z * t));
    }
    // RK4 on BallFlight.acceleration, written out on numbers (it runs inside every fit's residuals).
    const axis = BallFlight.spinAxis(v0);
    const ax = axis.x, ay = axis.y, az = axis.z;
    const k = BallFlight.k, kd = k * aero.drag, kl = k * aero.lift;
    const acc = (vx: number, vy: number, vz: number, out: number[], o: number) => {
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const d = -kd * speed, m = kl * speed;
      // gravity + drag v + lift (axis x v)
      out[o] = 0 + vx * d + (ay * vz - az * vy) * m;
      out[o + 1] = -g + vy * d + (az * vx - ax * vz) * m;
      out[o + 2] = 0 + vz * d + (ax * vy - ay * vx) * m;
    };
    const a = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const state = [0, 0, 0, 0, 0, 0];
    // One RK4 step of length h from `state` into `state` (positions only when `positionOnly`).
    const step = (h: number) => {
      const px = state[0], py = state[1], pz = state[2], vx = state[3], vy = state[4], vz = state[5];
      acc(vx, vy, vz, a, 0);
      const v2x = vx + a[0] * (h / 2), v2y = vy + a[1] * (h / 2), v2z = vz + a[2] * (h / 2);
      acc(v2x, v2y, v2z, a, 3);
      const v3x = vx + a[3] * (h / 2), v3y = vy + a[4] * (h / 2), v3z = vz + a[5] * (h / 2);
      acc(v3x, v3y, v3z, a, 6);
      const v4x = vx + a[6] * h, v4y = vy + a[7] * h, v4z = vz + a[8] * h;
      acc(v4x, v4y, v4z, a, 9);
      state[0] = px + (vx + v2x * 2 + v3x * 2 + v4x) * (h / 6);
      state[1] = py + (vy + v2y * 2 + v3y * 2 + v4y) * (h / 6);
      state[2] = pz + (vz + v2z * 2 + v3z * 2 + v4z) * (h / 6);
      state[3] = vx + (a[0] + a[3] * 2 + a[6] * 2 + a[9]) * (h / 6);
      state[4] = vy + (a[1] + a[4] * 2 + a[7] * 2 + a[10]) * (h / 6);
      state[5] = vz + (a[2] + a[5] * 2 + a[8] * 2 + a[11]) * (h / 6);
    };
    const out: V3[] = times.map(() => p0);
    for (const direction of [1, -1]) {
      const order = times.map((_, i) => i).filter((i) => times[i] * direction > 0)
        .sort((i, j) => Math.abs(times[i]) - Math.abs(times[j]));
      state[0] = p0.x; state[1] = p0.y; state[2] = p0.z; state[3] = v0.x; state[4] = v0.y; state[5] = v0.z;
      let tau = 0;
      for (const i of order) {
        const target = Math.abs(times[i]);
        while (tau + dt <= target) {
          step(dt * direction);
          tau += dt;
        }
        const h = target - tau;
        if (h > 1e-12) {
          const saved = [...state];
          step(h * direction);
          out[i] = new V3(state[0], state[1], state[2]);
          for (let s = 0; s < 6; s++) state[s] = saved[s];
        } else {
          out[i] = new V3(state[0], state[1], state[2]);
        }
      }
    }
    return out;
  }

  encode(): BallSegmentJSON {
    return { t0: this.t0, t1: this.t1, p0: this.p0.toJSON(), v0: this.v0.toJSON(), aero: { drag: this.aero.drag, lift: this.aero.lift },
      rmsError: this.rmsError };
  }

  static decode(j: BallSegmentJSON): BallSegment {
    return new BallSegment(j.t0, j.t1, new V3(j.p0.x, j.p0.y, j.p0.z), new V3(j.v0.x, j.v0.y, j.v0.z),
      { drag: j.aero.drag, lift: j.aero.lift }, j.rmsError);
  }
}

/**
 * What else is known about the ball at a moment: a contact by a player (where they stand, roughly how high) or a
 * bounce on the floor (only its height). Monocular depth is only as good as the assumed spin (Magnus lift changes the
 * apparent gravity that fixes the scale), so anchors are what make short or spinning flights metric.
 */
export interface BallAnchor {
  time: number;
  position: V3;
  /** Standard deviations in metres of the horizontal (x and z) and vertical position; undefined leaves that part free. */
  horizontalSigma?: number;
  verticalSigma?: number;
  /**
   * The spin expected of the flight this contact starts (`BallReconstruction.expectedAero`), used as the prior of the
   * fitted lift coefficient.
   */
  aero?: Aero;
}

export const BallAnchor = {
  /** The ball on the floor (landing or bounce): its centre one radius up, anywhere. */
  floor(time: number): BallAnchor {
    return { time, position: new V3(0, BallFlight.radius, 0), verticalSigma: 0.03 };
  },

  /**
   * A contact at a hand of a fitted pose (`SkeletonModel.fingertip` of the posed player): the pose library places a
   * hand to about 0.2 m.
   */
  hand(time: number, position: V3, sigma = 0.3, aero?: Aero): BallAnchor {
    const a: BallAnchor = { time, position, horizontalSigma: sigma, verticalSigma: sigma };
    if (aero) a.aero = aero;
    return a;
  },

  /**
   * A contact by a player standing at `player`: the ball within about `horizontalSigma` of them (hands reach about
   * half a metre from the body), at `height` when known.
   */
  contact(time: number, player: FloorPoint, options: { height?: number; horizontalSigma?: number; verticalSigma?: number;
    aero?: Aero } = {}): BallAnchor {
    const a: BallAnchor = { time, position: V3.fromFloor(player, options.height ?? 0), horizontalSigma: options.horizontalSigma ?? 0.45 };
    if (options.height !== undefined) a.verticalSigma = options.verticalSigma ?? 0.5;
    if (options.aero) a.aero = options.aero;
    return a;
  },
};

/** Settings of the ball reconstruction (Swift `BallReconstruction.Settings`). */
export interface BallSettings {
  /** A flight's RMS reprojection error must stay below this (pixels at the video's resolution). */
  rmsThreshold: number;
  /** A new point joins the flight only when its own error is below this. */
  pointThreshold: number;
  /** Points per flight at least. */
  minPoints: number;
  /** Longer gaps without the ball always end a flight (seconds). */
  maxGap: number;
  /** Refine with drag and lift. */
  drag: boolean;
  /** Join consecutive flights at their contact (each pulls the other by its own uncertainty). */
  chain: boolean;
}

export const defaultBallSettings: Readonly<BallSettings> = { rmsThreshold: 3, pointThreshold: 7, minPoints: 5, maxGap: 0.35, drag: true, chain: true };

/** The flight model's free parameters: launch position and velocity, and the lift coefficient when it is free. */
interface Fit {
  p0: V3;
  v0: V3;
  aero: Aero;
  fitsLift: boolean;
  /** Total cost (pixels squared plus priors) and the pixel part. */
  cost: number;
  pixelCost: number;
  count: number;
}

function fitRMS(f: Fit): number {
  return Math.sqrt(f.pixelCost / Math.max(f.count, 1));
}

function fitParams(f: Fit): number[] {
  return [f.p0.x, f.p0.y, f.p0.z, f.v0.x, f.v0.y, f.v0.z, ...(f.fitsLift ? [f.aero.lift] : [])];
}

/** Residual weights: pixels per metre below the floor; the lift prior without and with a contact hint. */
const floorWeight = 50.0;
const liftRange: [number, number] = [-0.1, 0.35];
const liftScale = 0.2;
const hintedLiftScale = 0.04;

const clampLift = (x: number) => Math.min(liftRange[1], Math.max(liftRange[0], x));

class Problem {
  liftPrior: { centre: number; scale: number } = { centre: 0, scale: liftScale };

  constructor(
    readonly obs: readonly BallObservation[],
    readonly t0: number,
    readonly camera: VideoCamera,
    readonly anchors: readonly BallAnchor[],
    readonly aero: Aero,
    readonly fitsLift: boolean,
  ) {}

  aeroOf(x: readonly number[]): Aero {
    return this.fitsLift ? { drag: this.aero.drag, lift: clampLift(x[6]) } : this.aero;
  }

  positions(x: readonly number[], times: readonly number[]): V3[] {
    return BallSegment.positions(new V3(x[0], x[1], x[2]), new V3(x[3], x[4], x[5]), this.aeroOf(x), times.map((t) => t - this.t0));
  }

  /**
   * Pixel residuals, floor penalties, anchor residuals (in sigmas) and the lift prior; undefined when the ball would be
   * behind the camera.
   */
  residuals(x: readonly number[]): { all: number[]; pixelCost: number } | undefined {
    const ps = this.positions(x, [...this.obs.map((o) => o.time), ...this.anchors.map((a) => a.time)]);
    const r: number[] = [];
    let pixelCost = 0;
    for (let i = 0; i < this.obs.length; i++) {
      const o = this.obs[i], p = ps[i];
      const q = this.camera.project(p);
      if (!q) return undefined;
      const dx = q.x - o.image.x, dy = q.y - o.image.y;
      r.push(dx, dy);
      pixelCost += dx * dx + dy * dy;
      r.push(Math.max(0, BallFlight.radius - p.y) * floorWeight);
    }
    this.anchors.forEach((a, k) => {
      const p = ps[this.obs.length + k];
      if (a.horizontalSigma !== undefined) {
        r.push((p.x - a.position.x) / a.horizontalSigma);
        r.push((p.z - a.position.z) / a.horizontalSigma);
      }
      if (a.verticalSigma !== undefined) r.push((p.y - a.position.y) / a.verticalSigma);
    });
    if (this.fitsLift) r.push((x[6] - this.liftPrior.centre) / this.liftPrior.scale);
    return { all: r, pixelCost };
  }

  refine(x0: readonly number[], maxIterations = 60): Fit | undefined {
    const steps = new Array<number>(x0.length).fill(1e-5);
    const clamp = (x: number[]) => {
      if (!this.fitsLift) return x;
      const y = [...x];
      y[6] = clampLift(y[6]);
      return y;
    };
    const r = LevenbergMarquardt.minimize(x0, steps, (x) => this.residuals(x)?.all, { maxIterations, tolerance: 1e-10, clamp });
    if (!r) return undefined;
    const e = this.residuals(r.x);
    if (!e) return undefined;
    return { p0: new V3(r.x[0], r.x[1], r.x[2]), v0: new V3(r.x[3], r.x[4], r.x[5]), aero: this.aeroOf(r.x), fitsLift: this.fitsLift,
      cost: r.cost, pixelCost: e.pixelCost, count: this.obs.length };
  }

  /**
   * Standard deviation (metres, all axes together) of the fitted position at time t, from the Gauss-Newton covariance
   * of the parameters with one-pixel measurement noise.
   */
  positionSigma(fit: Fit, t: number): number {
    const x = fitParams(fit), n = x.length;
    const r0 = this.residuals(x)?.all;
    if (!r0) return Infinity;
    const m = r0.length;
    const jac = new Float64Array(m * n);
    const jp = [new Array<number>(n).fill(0), new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
    for (let j = 0; j < n; j++) {
      const h = 1e-5;
      const xp = [...x], xm = [...x];
      xp[j] += h;
      xm[j] -= h;
      const rp = this.residuals(xp)?.all, rm = this.residuals(xm)?.all;
      if (!rp || !rm) return Infinity;
      for (let i = 0; i < m; i++) jac[i * n + j] = (rp[i] - rm[i]) / (2 * h);
      const pp = this.positions(xp, [t])[0], pm = this.positions(xm, [t])[0];
      jp[0][j] = (pp.x - pm.x) / (2 * h);
      jp[1][j] = (pp.y - pm.y) / (2 * h);
      jp[2][j] = (pp.z - pm.z) / (2 * h);
    }
    const jtj = new Array<number>(n * n).fill(0);
    for (let i = 0; i < m; i++) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) jtj[a * n + b] += jac[i * n + a] * jac[i * n + b];
    let variance = 0;
    for (let k = 0; k < 3; k++) {
      const y = LinearAlgebra.solve(jtj, jp[k], n);
      if (!y) return Infinity;
      for (let i = 0; i < n; i++) variance += jp[k][i] * y[i];
    }
    return variance > 0 ? Math.sqrt(variance) : Infinity;
  }
}

/**
 * Monocular ball reconstruction (Section 4.4). Gravity is known, so with the frame timing it fixes the metric scale:
 * the fit solves the launch position and velocity by Levenberg-Marquardt on the reprojection error, from a linear
 * (DLT-like) start and several depths along the first ray, drag-free first, then with the BallFlight drag model. The
 * scale is only as good as the assumed spin, so the fit also uses `BallAnchor`s (contacts, bounces), keeps the ball
 * above the floor, frees the lift coefficient when anchors pin the scale, and chains consecutive flights through
 * their shared contact point.
 */
export const BallReconstruction = {
  /**
   * The spin a contact gives the ball, as the core's ball plan models it: attacks and jump serves topspin, float
   * serves none, passes, digs and sets a little backspin. Undefined for a block (a deflection) or no contact.
   */
  expectedAero(posture: Posture): Aero | undefined {
    switch (posture) {
      case "attack": case "quickAttack": case "armCock": case "jumpServe": return { ...Aero.topspin };
      case "floatServe": return { ...Aero.float };
      case "pass": case "angledPass": case "set": case "backSet": case "jumpSet": case "overheadPass": case "dig": case "sprawl":
      case "lowDefence": case "cover":
        return { ...Aero.soft };
      default: return undefined;
    }
  },

  /** The lift prior (centre, scale) of a flight: the spin hint of a contact at its start, else no spin, loosely. */
  liftPrior(anchors: readonly BallAnchor[], start: number): { centre: number; scale: number } {
    let best: BallAnchor | undefined;
    for (const a of anchors) {
      if (!a.aero || !(Math.abs(a.time - start) <= 0.15)) continue;
      if (!best || Math.abs(a.time - start) < Math.abs(best.time - start)) best = a;
    }
    return best?.aero ? { centre: best.aero.lift, scale: hintedLiftScale } : { centre: 0, scale: liftScale };
  },

  /**
   * Drag-free start by linear least squares: each pixel gives two equations linear in (p0, v0) once the projection
   * is cross-multiplied, (u' r3 - f r1) . (p0 + tau v0 + g tau^2 / 2 - C) = 0, likewise for v'. With `p0` given only
   * v0 is solved.
   */
  linearStart(obs: readonly BallObservation[], t0: number, camera: VideoCamera, p0?: V3): [V3, V3] | undefined {
    const r = camera.matrix, f = camera.focalLength, c = camera.center;
    const g = new V3(0, -BallFlight.gravity, 0);
    const rows: number[][] = [], rhs: number[] = [];
    for (const o of obs) {
      const tau = o.time - t0;
      const u = o.image.x - camera.width / 2, v = o.image.y - camera.height / 2;
      for (const a0 of [r.r2.mul(u).sub(r.r0.mul(f)), r.r2.mul(v).sub(r.r1.mul(f))]) {
        const n = a0.length;
        if (!(n > 0)) continue;
        const a = a0.mul(1 / n);
        let y = a.dot(c) - 0.5 * tau * tau * a.dot(g);
        if (p0) {
          y -= a.dot(p0);
          rows.push([tau * a.x, tau * a.y, tau * a.z]);
        } else {
          rows.push([a.x, a.y, a.z, tau * a.x, tau * a.y, tau * a.z]);
        }
        rhs.push(y);
      }
    }
    if (p0) {
      const x = LinearAlgebra.leastSquares(rows, rhs, 3);
      return x ? [p0, new V3(x[0], x[1], x[2])] : undefined;
    }
    const x = LinearAlgebra.leastSquares(rows, rhs, 6);
    return x ? [new V3(x[0], x[1], x[2]), new V3(x[3], x[4], x[5])] : undefined;
  },

  /**
   * The best drag-free flight (t0 = the first observation): LM from the linear start and from depths of 3 to 40 m
   * along the first ray, or from `warm`.
   */
  ballistic(obs: readonly BallObservation[], camera: VideoCamera, anchors: readonly BallAnchor[] = [], warm?: Fit): Fit | undefined {
    if (obs.length < 3) return undefined;
    const t0 = obs[0].time;
    const problem = new Problem(obs, t0, camera, anchors, BallSegment.vacuum, false);
    if (warm) {
      const f = problem.refine(fitParams(warm).slice(0, 6), 20);
      if (f) return f;
    }
    const starts: [V3, V3][] = [];
    const s0 = BallReconstruction.linearStart(obs, t0, camera);
    if (s0) starts.push(s0);
    const ray = camera.ray(obs[0].image);
    for (const depth of [3, 5, 8, 12, 18, 26, 40]) {
      const s = BallReconstruction.linearStart(obs, t0, camera, ray.origin.add(ray.direction.mul(depth)));
      if (s) starts.push(s);
    }
    let best: Fit | undefined;
    for (const s of starts) {
      const f = problem.refine([s[0].x, s[0].y, s[0].z, s[1].x, s[1].y, s[1].z]);
      if (!f) continue;
      if (!best || f.cost < best.cost) best = f;
    }
    return best;
  },

  /**
   * Drag-free first, then the BallFlight model with drag: without anchors as a float (no spin, which the image cannot
   * measure), kept if it fits at least as well; with anchors the lift coefficient is fitted too.
   */
  bestFit(obs: readonly BallObservation[], camera: VideoCamera, anchors: readonly BallAnchor[], drag: boolean): Fit | undefined {
    if (obs.length === 0) return undefined;
    const t0 = obs[0].time;
    const free = BallReconstruction.ballistic(obs, camera, anchors);
    if (!free) return undefined;
    if (!drag) return free;
    const base = fitParams(free).slice(0, 6);
    if (anchors.length === 0) {
      const problem = new Problem(obs, t0, camera, [], Aero.float, false);
      const f = problem.refine(base, 40);
      if (!f) return free;
      return f.cost <= free.cost ? f : free;
    }
    const problem = new Problem(obs, t0, camera, anchors, Aero.float, true);
    problem.liftPrior = BallReconstruction.liftPrior(anchors, t0);
    let best = free;
    for (const lift of [...new Set([problem.liftPrior.centre, 0, 0.15])].sort((a, b) => a - b)) {
      const f = problem.refine([...base, lift], 40);
      if (!f) continue;
      if (f.cost < best.cost) best = f;
    }
    return best;
  },

  problemFor(fit: Fit, obs: readonly BallObservation[], camera: VideoCamera, anchors: readonly BallAnchor[]): Problem {
    const p = new Problem(obs, obs[0].time, camera, anchors, fit.aero, fit.fitsLift);
    p.liftPrior = BallReconstruction.liftPrior(anchors, obs[0].time);
    return p;
  },

  /**
   * One flight through all the observations (with optional anchors). Undefined with fewer than four observations or
   * no flight in front of the camera.
   */
  fit(observations: readonly BallObservation[], camera: VideoCamera, anchors: readonly BallAnchor[] = [], drag = true): BallSegment | undefined {
    const obs = [...observations].sort((a, b) => a.time - b.time);
    if (obs.length < 4) return undefined;
    const best = BallReconstruction.bestFit(obs, camera, anchors, drag);
    if (!best) return undefined;
    return new BallSegment(obs[0].time, obs[obs.length - 1].time, best.p0, best.v0, best.aero, fitRMS(best));
  },

  /**
   * Splits a ball track into flights at contacts: a flight grows point by point while its drag-free fit stays below
   * `rmsThreshold` and the new point below `pointThreshold`; then each boundary moves by up to three points to the
   * split with the lowest total error. Groups shorter than `minPoints` are dropped (a held ball, noise).
   */
  split(observations: readonly BallObservation[], camera: VideoCamera, settings: Partial<BallSettings> = {}): BallObservation[][] {
    const s = { ...defaultBallSettings, ...settings };
    const obs = [...observations].sort((a, b) => a.time - b.time);
    const n = obs.length;
    const minPoints = Math.max(4, s.minPoints);
    const pointError = (f: Fit, o: BallObservation, t0: number) => {
      const p = BallSegment.positions(f.p0, f.v0, f.aero, [o.time - t0])[0];
      const q = camera.project(p);
      return q ? ImagePoint.distance(q, o.image) : Infinity;
    };
    const ranges: [number, number][] = [];
    let start = 0;
    while (start + minPoints <= n) {
      let end = start + minPoints;
      let gap: number | undefined;
      for (let i = start + 1; i < end; i++) if (obs[i].time - obs[i - 1].time > s.maxGap) { gap = i; break; }
      if (gap !== undefined) {
        start = gap;
        continue;
      }
      let fit = BallReconstruction.ballistic(obs.slice(start, end), camera);
      if (!fit || !(fitRMS(fit) <= s.rmsThreshold)) {
        start += 1;
        continue;
      }
      while (end < n && obs[end].time - obs[end - 1].time <= s.maxGap) {
        const candidate: Fit | undefined = BallReconstruction.ballistic(obs.slice(start, end + 1), camera, [], fit);
        if (!candidate || !(fitRMS(candidate) <= s.rmsThreshold) || !(pointError(candidate, obs[end], obs[start].time) <= s.pointThreshold)) break;
        fit = candidate;
        end += 1;
      }
      ranges.push([start, end]);
      start = end;
    }
    const cost = (lo: number, hi: number) => BallReconstruction.ballistic(obs.slice(lo, hi), camera)?.pixelCost ?? Infinity;
    if (ranges.length > 1) {
      for (let i = 0; i < ranges.length - 1; i++) {
        const a = ranges[i], b = ranges[i + 1];
        if (b[0] !== a[1]) continue;
        let best = { cost: cost(a[0], a[1]) + cost(b[0], b[1]), split: a[1] };
        for (let sp = a[1] - 3; sp <= a[1] + 3; sp++) {
          if (sp === a[1]) continue;
          if (sp - a[0] < minPoints || b[1] - sp < minPoints) continue;
          const c = cost(a[0], sp) + cost(sp, b[1]);
          if (c < best.cost) best = { cost: c, split: sp };
        }
        ranges[i] = [a[0], best.split];
        ranges[i + 1] = [best.split, b[1]];
      }
    }
    return ranges.map(([lo, hi]) => obs.slice(lo, hi));
  },

  /**
   * Reconstructs flights (observation groups from `split`) with the anchors falling in or next to each, places the
   * contact between consecutive flights where they pass closest, and chains them there: both flights are refitted
   * with the contact point fused from the two by their uncertainties.
   */
  reconstruct(flights: readonly (readonly BallObservation[])[], camera: VideoCamera, anchors: readonly BallAnchor[] = [],
    settings: Partial<BallSettings> = {}): BallSegment[] {
    const s = { ...defaultBallSettings, ...settings };
    const groups = flights.map((g) => [...g].sort((a, b) => a.time - b.time)).filter((g) => g.length >= 4);
    const own = (g: readonly BallObservation[]) =>
      anchors.filter((a) => a.time >= g[0].time - 0.15 && a.time <= g[g.length - 1].time + 0.15);
    const extra: BallAnchor[][] = groups.map(() => []);
    const fits = groups.map((g) => BallReconstruction.bestFit(g, camera, own(g), s.drag));
    // Contact times where consecutive flights pass closest.
    const contacts: (number | undefined)[] = groups.map(() => undefined);
    const segment = (i: number): BallSegment | undefined => {
      const f = fits[i];
      if (!f) return undefined;
      const g = groups[i];
      return new BallSegment(g[0].time, g[g.length - 1].time, f.p0, f.v0, f.aero, fitRMS(f));
    };
    for (let i = 0; i < groups.length - 1; i++) {
      const a = segment(i), b = segment(i + 1);
      if (!a || !b || !(b.t0 - a.t1 <= s.maxGap + 1e-9)) continue;
      let best = { d: Infinity, t: (a.t1 + b.t0) / 2 };
      for (let k = 0; k <= 24; k++) {
        const t = a.t1 + ((b.t0 - a.t1) * k) / 24;
        const d = a.unclamped(t).sub(b.unclamped(t)).length;
        if (d < best.d) best = { d, t };
      }
      contacts[i] = best.t;
    }
    if (s.chain) {
      for (let i = 0; i < groups.length - 1; i++) {
        const tc = contacts[i], fa = fits[i], fb = fits[i + 1];
        if (tc === undefined || !fa || !fb) continue;
        const pa = BallReconstruction.problemFor(fa, groups[i], camera, own(groups[i]));
        const pb = BallReconstruction.problemFor(fb, groups[i + 1], camera, own(groups[i + 1]));
        const sa = pa.positionSigma(fa, tc), sb = pb.positionSigma(fb, tc);
        if (!Number.isFinite(sa) && !Number.isFinite(sb)) continue;
        const xa = pa.positions(fitParams(fa), [tc])[0], xb = pb.positions(fitParams(fb), [tc])[0];
        const wa = Number.isFinite(sa) ? 1 / (sa * sa) : 0, wb = Number.isFinite(sb) ? 1 / (sb * sb) : 0;
        const fused = xa.mul(wa).add(xb.mul(wb)).mul(1 / (wa + wb));
        const sigma = Math.sqrt(1 / (wa + wb)) + 0.05;
        const anchor: BallAnchor = { time: tc, position: fused, horizontalSigma: sigma, verticalSigma: sigma };
        extra[i].push(anchor);
        extra[i + 1].push(anchor);
      }
      groups.forEach((g, i) => {
        const f = fits[i];
        if (extra[i].length === 0 || !f) return;
        const p = new Problem(g, g[0].time, camera, [...own(g), ...extra[i]], f.aero, s.drag);
        p.liftPrior = BallReconstruction.liftPrior(own(g), g[0].time);
        const x0 = [...fitParams(f).slice(0, 6), ...(s.drag ? [f.fitsLift ? f.aero.lift : 0] : [])];
        const refit = p.refine(x0, 40);
        if (refit) fits[i] = refit;
      });
    }
    const segments: BallSegment[] = [];
    for (let i = 0; i < groups.length; i++) {
      let seg = segment(i);
      if (!seg) continue;
      const before = i > 0 ? contacts[i - 1] : undefined;
      if (before !== undefined) {
        const p = seg.unclamped(before), v = seg.velocity(before);
        seg = new BallSegment(before, seg.t1, p, v, seg.aero, seg.rmsError);
      }
      const after = contacts[i];
      if (after !== undefined) seg.t1 = after;
      segments.push(seg);
    }
    return segments;
  },

  /** `split` then `reconstruct`. */
  segment(observations: readonly BallObservation[], camera: VideoCamera, anchors: readonly BallAnchor[] = [],
    settings: Partial<BallSettings> = {}): BallSegment[] {
    return BallReconstruction.reconstruct(BallReconstruction.split(observations, camera, settings), camera, anchors, settings);
  },
};
