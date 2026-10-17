// Port of Spatial/BallFlight.swift: gravity, quadratic drag and Magnus lift, integrated with RK4 at 1 ms
// (Sections 4.7 and 5.4). Constants as in Appendix D: radius 0.105 m, mass 0.27 kg, air 1.2 kg/m^3, C_D 0.25.
import { V3 } from "./math3d";

/** Swift `BallFlight.Aero`: drag coefficient and signed lift (positive topspin pushes down, negative backspin). */
export interface Aero {
  drag: number;
  lift: number;
}

export const Aero = {
  create(drag = 0.25, lift = 0): Aero {
    return { drag, lift };
  },
  float: { drag: 0.25, lift: 0 } as Readonly<Aero>,
  topspin: { drag: 0.25, lift: 0.15 } as Readonly<Aero>,
  /** A set or pass carries a little backspin; a small lift keeps the model honest without a spin measurement. */
  soft: { drag: 0.25, lift: -0.03 } as Readonly<Aero>,
};

/** Swift `BallFlight.Sample`: time, position and velocity. */
export interface FlightSample {
  t: number;
  p: V3;
  v: V3;
}

export const BallFlight = {
  radius: 0.105,
  mass: 0.27,
  airDensity: 1.2,
  gravity: 9.81,

  /** rho A / 2m, about 0.077 per metre. */
  get k(): number {
    return (BallFlight.airDensity * Math.PI * BallFlight.radius * BallFlight.radius) / (2 * BallFlight.mass);
  },

  /**
   * Acceleration at velocity v. The spin axis lies horizontal and perpendicular to the flight plane, so topspin lift
   * points down for a forward-moving ball and the flight stays in its vertical plane.
   */
  acceleration(v: V3, aero: Aero, axis: V3): V3 {
    const k = BallFlight.k;
    const speed = v.length;
    const drag = v.mul(-k * aero.drag * speed);
    const magnus = axis.cross(v).mul(k * aero.lift * speed);
    return new V3(0, -BallFlight.gravity, 0).add(drag).add(magnus);
  },

  /** The topspin axis for a horizontal heading: up x heading, so axis x v points down. */
  spinAxis(h: V3): V3 {
    const flat = new V3(h.x, 0, h.z).normalized;
    return flat.length > 0.5 ? V3.up.cross(flat) : new V3(1, 0, 0);
  },

  /** Integrates from p0 with v0 until `stop` says so or `maxTime` passes; keeps every `keepEvery`-th step. */
  simulate(p0: V3, v0: V3, aero: Aero, stop: (s: FlightSample) => boolean,
    options: { dt?: number; maxTime?: number; keepEvery?: number } = {}): FlightSample[] {
    const dt = options.dt ?? 0.001, maxTime = options.maxTime ?? 6, keepEvery = options.keepEvery ?? 10;
    const axis = BallFlight.spinAxis(v0);
    let s: FlightSample = { t: 0, p: p0, v: v0 };
    const out: FlightSample[] = [s];
    let step = 0;
    while (s.t < maxTime) {
      const p = s.p, v = s.v;
      const a1 = BallFlight.acceleration(v, aero, axis);
      const v2 = v.add(a1.mul(dt / 2)), a2 = BallFlight.acceleration(v2, aero, axis);
      const v3 = v.add(a2.mul(dt / 2)), a3 = BallFlight.acceleration(v3, aero, axis);
      const v4 = v.add(a3.mul(dt)), a4 = BallFlight.acceleration(v4, aero, axis);
      const nextP = p.add(v.add(v2.mul(2)).add(v3.mul(2)).add(v4).mul(dt / 6));
      const nextV = v.add(a1.add(a2.mul(2)).add(a3.mul(2)).add(a4).mul(dt / 6));
      s = { t: s.t + dt, p: nextP, v: nextV };
      step += 1;
      if (stop(s)) {
        out.push(s);
        break;
      }
      if (step % keepEvery === 0) out.push(s);
    }
    return out;
  },
};

/** Net check of Section 5.5: the ball centre must pass above the tape by its radius and between the antennas. */
export class NetCrossing {
  constructor(
    readonly x: number,
    readonly height: number,
    readonly netHeight: number,
  ) {}

  get clearance(): number {
    return this.height - this.netHeight - BallFlight.radius;
  }
  get insideAntennas(): boolean {
    return Math.abs(this.x) <= 4.5 - BallFlight.radius;
  }
  get clears(): boolean {
    return this.clearance > 0 && this.insideAntennas;
  }
}

/** A solved flight between two points. */
export class Trajectory {
  constructor(
    readonly samples: FlightSample[],
    readonly aero: Aero,
  ) {}

  get start(): V3 {
    return this.samples[0].p;
  }
  get end(): V3 {
    return this.samples[this.samples.length - 1].p;
  }
  get duration(): number {
    return this.samples[this.samples.length - 1].t;
  }
  get launchSpeed(): number {
    return this.samples[0].v.length;
  }
  get apex(): number {
    if (this.samples.length === 0) return 0;
    let top = -Infinity;
    for (const s of this.samples) top = Math.max(top, s.p.y);
    return top;
  }

  /** Position at flight time t (linear between kept samples, which are 10 ms apart). */
  position(t: number): V3 {
    if (!(t > 0)) return this.start;
    if (!(t < this.duration)) return this.end;
    let i = 1;
    while (i < this.samples.length - 1 && this.samples[i].t < t) i += 1;
    const a = this.samples[i - 1], b = this.samples[i];
    const f = (t - a.t) / Math.max(b.t - a.t, 1e-9);
    return a.p.add(b.p.sub(a.p).mul(f));
  }

  /** Where and how high the ball crosses the net plane (Z = 0), if it does. */
  netCrossing(netHeight: number): NetCrossing | undefined {
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1].p, b = this.samples[i].p;
      if ((a.z < 0) === (b.z < 0)) continue;
      const f = a.z / (a.z - b.z);
      const p = a.add(b.sub(a).mul(f));
      return new NetCrossing(p.x, p.y, netHeight);
    }
    return undefined;
  }
}

/** Keeps every 10th step (10 ms) plus the exact end, placed on the target so chained flights connect. */
function thin(samples: FlightSample[], target: V3): FlightSample[] {
  const out = samples.filter((_, i) => i % 10 === 0);
  const last = { ...samples[samples.length - 1], p: target };
  if (out.length > 0 && out[out.length - 1].t === last.t) out.pop();
  out.push(last);
  return out;
}

function lerpSample(a: FlightSample, b: FlightSample, f: number): FlightSample {
  return { t: a.t + (b.t - a.t) * f, p: a.p.add(b.p.sub(a.p).mul(f)), v: a.v.add(b.v.sub(a.v).mul(f)) };
}

/**
 * Flights solved so far, by everything that decides them (solving one takes milliseconds of shooting): an edit to the
 * board that leaves a flight's ends where they were finds it here. Trajectories are never changed once made.
 */
const solvedFlights = new Map<string, Trajectory | undefined>();

function remembered(key: string, solve: () => Trajectory | undefined): Trajectory | undefined {
  if (solvedFlights.has(key)) {
    const t = solvedFlights.get(key);
    // Most recently used last, so the oldest go first.
    solvedFlights.delete(key);
    solvedFlights.set(key, t);
    return t;
  }
  const t = solve();
  solvedFlights.set(key, t);
  if (solvedFlights.size > 256) solvedFlights.delete(solvedFlights.keys().next().value!);
  return t;
}

/** Two-point boundary value problems by shooting (Section 5.4). */
export const FlightSolver = {
  /**
   * The low, driven trajectory from `from` to `to` at launch speed `speed` (serves, attacks), or undefined when the
   * target is out of reach at that speed. The ball's centre ends at `to`.
   */
  aim(from: V3, to: V3, speed: number, aero: Aero): Trajectory | undefined {
    return remembered(`aim|${from.x}|${from.y}|${from.z}|${to.x}|${to.y}|${to.z}|${speed}|${aero.drag}|${aero.lift}`, () => {
      const flat = new V3(to.x - from.x, 0, to.z - from.z);
      const distance = flat.length;
      if (!(distance > 0.05)) return undefined;
      const heading = flat.mul(1 / distance);
      const along = (p: V3): number => new V3(p.x - from.x, 0, p.z - from.z).dot(heading);
      // Height above the target when the flight has covered the horizontal distance (exactly, by interpolating the
      // last step); undefined when the ball comes down first.
      const shoot = (theta: number, dt: number): [number, FlightSample[]] | undefined => {
        const v0 = heading.mul(Math.cos(theta)).add(V3.up.mul(Math.sin(theta))).mul(speed);
        const samples = BallFlight.simulate(from, v0, aero, (s) => along(s.p) >= distance || s.p.y < to.y - 3, { dt, keepEvery: 1 });
        if (samples.length < 2) return undefined;
        const b = samples[samples.length - 1], a = samples[samples.length - 2];
        if (!(along(b.p) >= distance)) return undefined;
        const f = (distance - along(a.p)) / Math.max(along(b.p) - along(a.p), 1e-12);
        const end = lerpSample(a, b, f);
        return [end.p.y - to.y, [...samples.slice(0, -1), end]];
      };
      const height = (theta: number, dt = 0.004): number => shoot(theta, dt)?.[0] ?? -1e3;
      // Scan upward from a steep downward angle for the first rise through the target (the low solution).
      let a = -1.2, fa = height(a);
      let bracket: [number, number] | undefined;
      let theta = a;
      while (theta < 1.3) {
        theta += 0.04;
        const f = height(theta);
        if (fa < 0 && f >= 0) {
          bracket = [a, theta];
          break;
        }
        a = theta;
        fa = f;
      }
      if (!bracket) return undefined;
      let [lo, hi] = bracket;
      for (let i = 0; i < 36; i++) {
        const m = (lo + hi) / 2;
        if (height(m, 0.001) < 0) lo = m;
        else hi = m;
      }
      const shot = shoot((lo + hi) / 2, 0.001);
      if (!shot) return undefined;
      return new Trajectory(thin(shot[1], to), aero);
  
    });
  },

  /**
   * The trajectory from `from` to `to` whose highest point is at height `apex` (passes, sets, free balls), solved by
   * Newton's method on the launch velocity starting from the drag-free answer.
   */
  lob(from: V3, to: V3, apex0: number, aero: Aero): Trajectory | undefined {
    return remembered(`lob|${from.x}|${from.y}|${from.z}|${to.x}|${to.y}|${to.z}|${apex0}|${aero.drag}|${aero.lift}`, () => {
      const flat = new V3(to.x - from.x, 0, to.z - from.z);
      const distance = flat.length;
      const heading = distance > 1e-6 ? flat.mul(1 / distance) : new V3(0, 0, 1);
      const apex = Math.max(apex0, Math.max(from.y, to.y) + 0.05);
      const g = BallFlight.gravity;
      // Drag-free start: rise to the apex, fall to the target height.
      const vy0 = Math.sqrt(2 * g * (apex - from.y));
      const tFlight = vy0 / g + Math.sqrt((2 * (apex - to.y)) / g);
      let x: [number, number] = [distance / tFlight, vy0];
      const run = (vh: number, vy: number): { residual: [number, number]; samples: FlightSample[] } | undefined => {
        const v0 = heading.mul(vh).add(V3.up.mul(vy));
        const samples = BallFlight.simulate(from, v0, aero, (s) => s.v.y < 0 && s.p.y <= to.y, { keepEvery: 1 });
        if (samples.length < 2) return undefined;
        const b = samples[samples.length - 1];
        if (!(b.v.y < 0 && b.p.y <= to.y)) return undefined;
        const a = samples[samples.length - 2];
        const f = (a.p.y - to.y) / Math.max(a.p.y - b.p.y, 1e-12);
        const end = lerpSample(a, b, f);
        // At 1 ms steps the highest sample is within micrometres of the true apex (the vertical speed is ~0 there).
        let top = -Infinity;
        for (const s of samples) top = Math.max(top, s.p.y);
        const covered = new V3(end.p.x - from.x, 0, end.p.z - from.z).dot(heading);
        return { residual: [covered - distance, top - apex], samples: [...samples.slice(0, -1), end] };
      };
      for (let iter = 0; iter < 30; iter++) {
        const r = run(x[0], x[1]);
        if (!r) return undefined;
        if (Math.abs(r.residual[0]) < 0.01 && Math.abs(r.residual[1]) < 0.01) return new Trajectory(thin(r.samples, to), aero);
        const h = 1e-3;
        const rx = run(x[0] + h, x[1]), ry = run(x[0], x[1] + h);
        if (!rx || !ry) return undefined;
        const j00 = (rx.residual[0] - r.residual[0]) / h, j01 = (ry.residual[0] - r.residual[0]) / h;
        const j10 = (rx.residual[1] - r.residual[1]) / h, j11 = (ry.residual[1] - r.residual[1]) / h;
        const det = j00 * j11 - j01 * j10;
        if (!(Math.abs(det) > 1e-12)) return undefined;
        const dx = (j11 * r.residual[0] - j01 * r.residual[1]) / det;
        const dy = (-j10 * r.residual[0] + j00 * r.residual[1]) / det;
        x = [Math.max(0, x[0] - dx), x[1] - dy];
      }
      return undefined;
  
    });
  },
};
