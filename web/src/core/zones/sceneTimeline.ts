// Port of Zones/SceneTimeline.swift: phase markers, keyframes and the scene at a moment of its timeline
// (Sections 3.3 and 3.5.7). `TacticalScene.frame(at:)` is `sceneFrame(scene, time)` (also `TacticalScene.frame`).
import type { FloorPoint } from "../match/court";
import { criticallyDamped } from "../spatial/boardCamera";
import type { Posture } from "../spatial/skeleton";
import type { SceneToken, TacticalScene } from "./tacticalScene";
import { Zone, ZoneGeometry, ZoneSDF } from "./zone";

/** Phase markers of a rally on a scene's timeline. */
export type RallyPhase = "serve" | "receive" | "set" | "attack" | "cover" | "defence";

export const RallyPhase = {
  allCases: ["serve", "receive", "set", "attack", "cover", "defence"] as readonly RallyPhase[],
  title(p: RallyPhase): string {
    return p.toUpperCase();
  },
};

/** A player's keyframe at a phase marker: where they stand and, optionally, their posture. */
export interface TokenKey {
  phase: RallyPhase;
  point: FloorPoint;
  posture?: Posture;
}

export const TokenKey = {
  create(phase: RallyPhase, point: FloorPoint, posture?: Posture): TokenKey {
    return posture === undefined ? { phase, point } : { phase, point, posture };
  },
};

/** A zone's keyframe at a phase marker: its geometry and style intensity (0 hides it, 1 is the full style). */
export interface ZoneKey {
  phase: RallyPhase;
  geometry: ZoneGeometry;
  intensity: number;
}

export const ZoneKey = {
  create(phase: RallyPhase, geometry: ZoneGeometry, intensity = 1): ZoneKey {
    return { phase, geometry, intensity };
  },
};

/**
 * A zone changing type between two keyframes (a circle becoming a rectangle): the floor shader blends the two signed
 * distances, d(t) = (1 - t) d0 + t d1. Not an exact distance field, but its zero contour morphs smoothly.
 */
export interface ZoneMorph {
  to: ZoneGeometry;
  t: number;
}

/** A posture changing between two keyframes; joints blend by quaternion slerp. */
export interface PostureBlend {
  from: Posture;
  to: Posture;
  t: number;
}

/** Ready on court, standing behind the end line (the server). Swift `SceneToken.automaticPosture(at:)`. */
export function automaticPosture(p: FloorPoint): Posture {
  return Math.abs(p.z) > 9 ? "standing" : "ready";
}

/** The scene at one moment of its timeline: tokens where they stand, zones in their shape and intensity. */
export class SceneFrame {
  /** Tokens with `point` and `posture` evaluated (posture is the blend's start while a blend runs). */
  tokens: SceneToken[] = [];
  postureBlends = new Map<string, PostureBlend>();
  /** Zones with `geometry` evaluated and the style opacity scaled by the intensity. */
  zones: Zone[] = [];
  intensities = new Map<string, number>();
  morphs = new Map<string, ZoneMorph>();

  /** Signed distance to a zone as drawn in this frame (morphs blend the two shapes). */
  distance(zone: Zone, p: FloorPoint): number {
    const d = Zone.distance(zone, p);
    const m = this.morphs.get(zone.id);
    if (!m) return d;
    return (1 - m.t) * d + m.t * ZoneSDF.distance(m.to, p);
  }

  /** The topmost visible zone under a point. Swift `zone(at:tolerance:)`. */
  zoneAt(p: FloorPoint, tolerance = 0.15): Zone | undefined {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      if ((this.intensities.get(z.id) ?? 1) > 0.05 && this.distance(z, p) <= tolerance) return z;
    }
    return undefined;
  }
}

/** The phase markers in use, in order; empty for a static scene. Swift `TacticalScene.timeline`. */
export function sceneTimeline(scene: TacticalScene): RallyPhase[] {
  return scene.phases ?? [];
}

/** Timeline position of a phase marker (phase-index units), or undefined when the scene does not use it. */
export function sceneTimeOf(scene: TacticalScene, phase: RallyPhase): number | undefined {
  const i = sceneTimeline(scene).indexOf(phase);
  return i >= 0 ? i : undefined;
}

/**
 * The scene at a timeline position in phase-index units (0 = the first marker). The base values of tokens and zones
 * are the first marker's; keyframes at later markers move them. Each interval eases critically damped.
 */
export function sceneFrame(scene: TacticalScene, time: number): SceneFrame {
  const line = sceneTimeline(scene);
  const index = (p: RallyPhase): number | undefined => {
    const i = line.indexOf(p);
    return i > 0 ? i : undefined;
  };
  const frame = new SceneFrame();
  for (const token of scene.tokens) {
    const keys: [number, FloorPoint, Posture][] = [[0, token.point, token.posture ?? automaticPosture(token.point)]];
    const sorted = (token.keys ?? [])
      .map((k): [TokenKey, number | undefined] => [k, index(k.phase)])
      .filter((e): e is [TokenKey, number] => e[1] !== undefined)
      .sort((a, b) => a[1] - b[1]);
    for (const [k, i] of sorted) {
      if (keys[keys.length - 1][0] === i) keys.pop();
      // A key without a posture keeps the previous one, unless the player is fully automatic.
      const posture = k.posture ?? (token.posture === undefined ? automaticPosture(k.point) : keys[keys.length - 1][2]);
      keys.push([i, k.point, posture]);
    }
    const t: SceneToken = { ...token };
    const [i, u] = Timeline.locate(time, keys.map((k) => k[0]));
    if (u === 0 || i + 1 >= keys.length) {
      t.point = keys[i][1];
      t.posture = keys[i][2];
    } else {
      t.point = Timeline.path(keys.map((k) => k[1]), i, u);
      t.posture = keys[i][2];
      if (keys[i][2] !== keys[i + 1][2]) frame.postureBlends.set(token.id, { from: keys[i][2], to: keys[i + 1][2], t: u });
    }
    frame.tokens.push(t);
  }
  for (const zone of scene.zones) {
    const keys: [number, ZoneGeometry, number][] = [[0, zone.geometry, 1]];
    const sorted = (zone.keys ?? [])
      .map((k): [ZoneKey, number | undefined] => [k, index(k.phase)])
      .filter((e): e is [ZoneKey, number] => e[1] !== undefined)
      .sort((a, b) => a[1] - b[1]);
    for (const [k, i] of sorted) {
      if (keys[keys.length - 1][0] === i) keys.pop();
      keys.push([i, k.geometry, k.intensity]);
    }
    const z: Zone = { ...zone };
    const [i, u] = Timeline.locate(time, keys.map((k) => k[0]));
    let intensity: number;
    if (u === 0 || i + 1 >= keys.length) {
      z.geometry = keys[i][1];
      intensity = keys[i][2];
    } else {
      const [g, morph] = ZoneInterpolation.interpolate(keys[i][1], keys[i + 1][1], u);
      z.geometry = g;
      if (morph) frame.morphs.set(zone.id, morph);
      intensity = keys[i][2] + (keys[i + 1][2] - keys[i][2]) * u;
    }
    z.style = { ...z.style, opacity: z.style.opacity * intensity };
    frame.intensities.set(zone.id, intensity);
    frame.zones.push(z);
  }
  return frame;
}

/** Timeline helpers: interval lookup with critically damped easing and paths through keyframes. */
export const Timeline = {
  /**
   * The interval of `time` among increasing key times: [index of the interval's first key, eased fraction]. Before
   * the first key or after the last, the fraction is 0 at the nearest key.
   */
  locate(time: number, keyTimes: readonly number[]): [number, number] {
    if (keyTimes.length <= 1) return [0, 0];
    const first = keyTimes[0], last = keyTimes[keyTimes.length - 1];
    if (time <= first) return [0, 0];
    if (time >= last) return [keyTimes.length - 1, 0];
    let i = 0;
    while (i + 1 < keyTimes.length && keyTimes[i + 1] <= time) i += 1;
    const a = keyTimes[i], b = keyTimes[i + 1];
    return [i, criticallyDamped((time - a) / (b - a))];
  },

  /**
   * A point on the open centripetal Catmull-Rom path through `points`, on the span from `points[k]` to
   * `points[k + 1]`, at arc-length fraction `u` (Section 3.3: paths reparametrized by arc length).
   */
  path(points: readonly FloorPoint[], k: number, u: number): FloorPoint {
    const p1 = points[k], p2 = points[k + 1];
    if (Math.hypot(p2.x - p1.x, p2.z - p1.z) < 1e-9) return p1;
    // End spans mirror the neighbour so the curve starts and ends straight.
    const p0 = k > 0 ? points[k - 1] : { x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z };
    const p3 = k + 2 < points.length ? points[k + 2] : { x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z };
    const samples = 24;
    const pts: FloorPoint[] = [p1];
    const lengths = [0.0];
    for (let s = 1; s <= samples; s++) {
      const q = Timeline.catmullRom(p0, p1, p2, p3, s / samples);
      lengths.push(lengths[s - 1] + Math.hypot(q.x - pts[s - 1].x, q.z - pts[s - 1].z));
      pts.push(q);
    }
    const target = Math.max(0, Math.min(1, u)) * lengths[samples];
    let s = 1;
    while (s < samples && lengths[s] < target) s += 1;
    const span = lengths[s] - lengths[s - 1];
    const f = span > 0 ? (target - lengths[s - 1]) / span : 0;
    return { x: pts[s - 1].x + (pts[s].x - pts[s - 1].x) * f, z: pts[s - 1].z + (pts[s].z - pts[s - 1].z) * f };
  },

  /** Centripetal (alpha = 0.5) Catmull-Rom between p1 and p2 at parameter fraction f. */
  catmullRom(p0: FloorPoint, p1: FloorPoint, p2: FloorPoint, p3: FloorPoint, f: number): FloorPoint {
    const knot = (a: FloorPoint, b: FloorPoint): number =>
      Math.max(Math.pow((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z), 0.25), 1e-6);
    const t0 = 0.0, t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    const t = t1 + (t2 - t1) * f;
    const mix = (a: FloorPoint, b: FloorPoint, ta: number, tb: number): FloorPoint => {
      const w = (t - ta) / (tb - ta);
      return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
    };
    const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
    const b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3);
    return mix(b1, b2, t1, t2);
  },
};

function blendPoints(p: readonly FloorPoint[], q: readonly FloorPoint[], t: number): FloorPoint[] {
  const n = Math.min(p.length, q.length);
  const out: FloorPoint[] = [];
  for (let i = 0; i < n; i++) out.push({ x: p[i].x + (q[i].x - p[i].x) * t, z: p[i].z + (q[i].z - p[i].z) * t });
  return out;
}

/** Zone keyframe interpolation (Section 3.5.7). */
export const ZoneInterpolation = {
  /** Points per outline when polygons of different vertex counts morph. */
  resampleCount: 64,

  /**
   * The geometry between two keyframes at eased fraction `t`, or the start geometry plus a signed-distance morph when
   * the type changes. Same type: centre and size interpolate linearly, the angle along the shortest arc; circles and
   * ellipses are one family. Polygons and freeforms: equal vertex counts interpolate directly after aligning the
   * start vertex; otherwise both outlines are resampled to 64 points by arc length first.
   */
  interpolate(a: ZoneGeometry, b: ZoneGeometry, t: number): [ZoneGeometry, ZoneMorph | undefined] {
    if (t <= 0) return [a, undefined];
    if (t >= 1) return [b, undefined];
    const lerp = (x: number, y: number): number => x + (y - x) * t;
    const lerpP = (p: FloorPoint, q: FloorPoint): FloorPoint => ({ x: lerp(p.x, q.x), z: lerp(p.z, q.z) });
    // Rectangles and ellipses look the same turned by pi, so their shortest arc is taken modulo pi.
    const angle = (x: number, y: number): number => {
      let d = (y - x) % Math.PI;
      if (d > Math.PI / 2) d -= Math.PI;
      if (d < -Math.PI / 2) d += Math.PI;
      return x + d * t;
    };
    if ("rect" in a && "rect" in b) {
      const r0 = a.rect, r1 = b.rect;
      return [ZoneGeometry.rect(lerpP(r0.center, r1.center), lerp(r0.halfWidth, r1.halfWidth), lerp(r0.halfDepth, r1.halfDepth),
        angle(r0.angle, r1.angle)), undefined];
    }
    if ("circle" in a && "circle" in b) {
      return [ZoneGeometry.circle(lerpP(a.circle.center, b.circle.center), lerp(a.circle.radius, b.circle.radius)), undefined];
    }
    if ("circle" in a && "ellipse" in b) {
      const r0 = a.circle.radius, e = b.ellipse;
      return [ZoneGeometry.ellipse(lerpP(a.circle.center, e.center), lerp(r0, e.a), lerp(r0, e.b), e.angle), undefined];
    }
    if ("ellipse" in a && "circle" in b) {
      const e = a.ellipse, r1 = b.circle.radius;
      return [ZoneGeometry.ellipse(lerpP(e.center, b.circle.center), lerp(e.a, r1), lerp(e.b, r1), e.angle), undefined];
    }
    if ("ellipse" in a && "ellipse" in b) {
      const e0 = a.ellipse, e1 = b.ellipse;
      return [ZoneGeometry.ellipse(lerpP(e0.center, e1.center), lerp(e0.a, e1.a), lerp(e0.b, e1.b), angle(e0.angle, e1.angle)), undefined];
    }
    if ("freeform" in a && "freeform" in b && a.freeform._0.length === b.freeform._0.length) {
      const start = ZoneInterpolation.oriented(a.freeform._0);
      return [ZoneGeometry.freeform(blendPoints(start, ZoneInterpolation.align(ZoneInterpolation.oriented(b.freeform._0), start), t)), undefined];
    }
    if ("polygon" in a && "polygon" in b && a.polygon._0.length === b.polygon._0.length) {
      const start = ZoneInterpolation.oriented(a.polygon._0);
      return [ZoneGeometry.polygon(blendPoints(start, ZoneInterpolation.align(ZoneInterpolation.oriented(b.polygon._0), start), t)), undefined];
    }
    if (("polygon" in a || "freeform" in a) && ("polygon" in b || "freeform" in b)) {
      const n = ZoneInterpolation.resampleCount;
      const p = ZoneInterpolation.resample(ZoneInterpolation.oriented(ZoneSDF.outline(a)), n);
      const q = ZoneInterpolation.resample(ZoneInterpolation.oriented(ZoneSDF.outline(b)), n);
      return [ZoneGeometry.polygon(blendPoints(p, ZoneInterpolation.align(q, p), t)), undefined];
    }
    return [a, { to: b, t }];
  },

  /** Signed area in the X-Z plane (positive counter-clockwise when looking down with X right and Z up). */
  signedArea(p: readonly FloorPoint[]): number {
    if (p.length < 3) return 0;
    let s = 0.0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      s += a.x * b.z - b.x * a.z;
    }
    return s / 2;
  },

  /** The same outline with counter-clockwise winding, so two outlines run the same way round before morphing. */
  oriented(p: readonly FloorPoint[]): FloorPoint[] {
    return ZoneInterpolation.signedArea(p) < 0 ? [...p].reverse() : [...p];
  },

  /** `count` points spaced evenly by arc length around a closed outline, starting at its first vertex. */
  resample(p: readonly FloorPoint[], count: number): FloorPoint[] {
    if (p.length < 2) return Array.from({ length: count }, () => p[0] ?? { x: 0, z: 0 });
    const cumulative = [0.0];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      cumulative.push(cumulative[i] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const total = cumulative[p.length];
    if (!(total > 0)) return Array.from({ length: count }, () => p[0]);
    const out: FloorPoint[] = [];
    let seg = 0;
    for (let k = 0; k < count; k++) {
      const s = (total * k) / count;
      while (seg < p.length - 1 && cumulative[seg + 1] < s) seg += 1;
      const a = p[seg], b = p[(seg + 1) % p.length];
      const len = cumulative[seg + 1] - cumulative[seg];
      const f = len > 0 ? (s - cumulative[seg]) / len : 0;
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
    }
    return out;
  },

  /** `q` cyclically shifted so its start lines up with `p`: the shift minimizing the sum of squared distances. */
  align(q: readonly FloorPoint[], p: readonly FloorPoint[]): FloorPoint[] {
    const n = q.length;
    if (!(n === p.length && n > 1)) return [...q];
    let bestShift = 0, bestCost = Infinity;
    for (let s = 0; s < n; s++) {
      let cost = 0.0;
      for (let i = 0; i < n; i++) {
        const a = p[i], b = q[(i + s) % n];
        cost += (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
        if (cost >= bestCost) break;
      }
      if (cost < bestCost) {
        bestShift = s;
        bestCost = cost;
      }
    }
    return Array.from({ length: n }, (_, i) => q[(i + bestShift) % n]);
  },
};
