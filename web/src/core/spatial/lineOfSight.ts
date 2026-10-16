// Port of Spatial/LineOfSight.swift: the capsule occluder model, line-of-sight rays and visual-field bands
// (Sections 5.6 and 5.7). UUIDs are strings.
import { V3 } from "./math3d";
import { Joint, type SkeletonModel } from "./skeleton";
import { swiftRound } from "./swiftCompat";
import type { Rigid } from "./math3d";

/** Parts of the occluder model, named for readouts such as "blocked by #14 left forearm". */
export type OccluderPart =
  | "head" | "torso"
  | "leftUpperArm" | "leftForearm" | "leftHand" | "rightUpperArm" | "rightForearm" | "rightHand"
  | "leftThigh" | "leftShank" | "rightThigh" | "rightShank"
  | "netTape" | "netBand" | "antenna" | "post";

const partTitles: Record<OccluderPart, string> = {
  head: "head",
  torso: "torso",
  leftUpperArm: "left upper arm",
  leftForearm: "left forearm",
  leftHand: "left hand",
  rightUpperArm: "right upper arm",
  rightForearm: "right forearm",
  rightHand: "right hand",
  leftThigh: "left thigh",
  leftShank: "left shank",
  rightThigh: "right thigh",
  rightShank: "right shank",
  netTape: "net tape",
  netBand: "net bottom band",
  antenna: "antenna",
  post: "post",
};

export const OccluderPart = {
  title(part: OccluderPart): string {
    return partTitles[part];
  },
};

function raySphere(o: V3, d: V3, c: V3, r: number): number | undefined {
  const oc = o.sub(c);
  const b = oc.dot(d), c2 = oc.dot(oc) - r * r;
  const h = b * b - c2;
  if (!(h >= 0)) return undefined;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : undefined;
}

/** A capsule (segment a-b inflated by `radius`; a sphere when a == b) in the shared body model of Section 5. */
export class Capsule {
  readonly a: V3;
  readonly b: V3;
  readonly radius: number;
  readonly owner: string | undefined;
  /** Short owner label for readouts, e.g. "#14". */
  readonly ownerLabel: string;
  readonly part: OccluderPart;

  constructor(init: { a: V3; b: V3; radius: number; owner?: string; ownerLabel?: string; part: OccluderPart }) {
    this.a = init.a;
    this.b = init.b;
    this.radius = init.radius;
    this.owner = init.owner;
    this.ownerLabel = init.ownerLabel ?? "";
    this.part = init.part;
  }

  get title(): string {
    return this.ownerLabel === "" ? partTitles[this.part] : `${this.ownerLabel} ${partTitles[this.part]}`;
  }

  /** Nearest intersection distance along a ray (unit direction) at or beyond the origin, or undefined. */
  intersect(o: V3, d: V3): number | undefined {
    if (this.b.sub(this.a).length < 1e-9) return raySphere(o, d, this.a, this.radius);
    return Capsule.rayCapsule(o, d, this.a, this.b, this.radius);
  }

  /** Ray versus capsule, Quilez's closed form: the cylinder body first, then the end caps. */
  static rayCapsule(o: V3, d: V3, a: V3, b: V3, r: number): number | undefined {
    const ba = b.sub(a), oa = o.sub(a);
    const baba = ba.dot(ba), bard = ba.dot(d), baoa = ba.dot(oa);
    const rdoa = d.dot(oa), oaoa = oa.dot(oa);
    const k2 = baba - bard * bard;
    const k1 = baba * rdoa - baoa * bard;
    const k0 = baba * oaoa - baoa * baoa - r * r * baba;
    if (k2 > 1e-12) {
      const h = k1 * k1 - k2 * k0;
      if (h < 0) return undefined;
      const t = (-k1 - Math.sqrt(h)) / k2;
      const y = baoa + t * bard;
      if (y > 0 && y < baba) return t >= 0 ? t : undefined;
      return raySphere(o, d, y <= 0 ? a : b, r);
    }
    // Parallel to the axis: only the caps can be hit first.
    const hits = [raySphere(o, d, a, r), raySphere(o, d, b, r)].filter((t): t is number => t !== undefined);
    return hits.length > 0 ? Math.min(...hits) : undefined;
  }

  static raySphere = raySphere;

  /** Value identity (Swift's synthesized Hashable). */
  get key(): string {
    const { a, b } = this;
    return [a.x, a.y, a.z, b.x, b.y, b.z, this.radius, this.owner ?? "", this.ownerLabel, this.part].join("|");
  }
}

/** The capsule model of every body and the net (Section 5.6). */
export const OccluderModel = {
  /** Capsules of a posed avatar. Radii are the blueprint's for a 1.90 m athlete, scaled by stature. */
  body(s: SkeletonModel, posed: readonly Rigid[], owner?: string, label = ""): Capsule[] {
    const k = s.metrics.stature / 1.9;
    const p = (j: Joint): V3 => posed[j].translation;
    const cap = (a: V3, b: V3, r: number, part: OccluderPart): Capsule =>
      new Capsule({ a, b, radius: r * k, owner, ownerLabel: label, part });
    const h = s.metrics.stature;
    const headCentre = posed[Joint.head].apply(new V3(0, 0.06 * h, 0.01 * h));
    return [
      cap(p(Joint.pelvis), p(Joint.neck), 0.15, "torso"),
      cap(headCentre, headCentre, 0.1, "head"),
      cap(p(Joint.lShoulder), p(Joint.lElbow), 0.05, "leftUpperArm"),
      cap(p(Joint.lElbow), p(Joint.lWrist), 0.04, "leftForearm"),
      cap(p(Joint.lWrist), s.fingertip(posed, true), 0.045, "leftHand"),
      cap(p(Joint.rShoulder), p(Joint.rElbow), 0.05, "rightUpperArm"),
      cap(p(Joint.rElbow), p(Joint.rWrist), 0.04, "rightForearm"),
      cap(p(Joint.rWrist), s.fingertip(posed, false), 0.045, "rightHand"),
      cap(p(Joint.lHip), p(Joint.lKnee), 0.08, "leftThigh"),
      cap(p(Joint.lKnee), p(Joint.lAnkle), 0.06, "leftShank"),
      cap(p(Joint.rHip), p(Joint.rKnee), 0.08, "rightThigh"),
      cap(p(Joint.rKnee), p(Joint.rAnkle), 0.06, "rightShank"),
    ];
  },

  /** The opaque parts of the net: the 7 cm tape, the 5 cm bottom band, the antennas (5 mm radius) and the posts.
   *  The 10 cm mesh transmits about 94% of light and is not an occluder (rays through it are labelled instead). */
  net(nh: number): Capsule[] {
    const out = [
      new Capsule({ a: new V3(-4.95, nh - 0.035, 0), b: new V3(4.95, nh - 0.035, 0), radius: 0.035, part: "netTape" }),
      new Capsule({ a: new V3(-4.95, nh - 0.975, 0), b: new V3(4.95, nh - 0.975, 0), radius: 0.025, part: "netBand" }),
    ];
    for (const s of [-1.0, 1.0]) {
      out.push(new Capsule({ a: new V3(s * 4.55, nh - 1, 0), b: new V3(s * 4.55, nh + 0.8, 0), radius: 0.005, part: "antenna" }));
      out.push(new Capsule({ a: new V3(s * 5.5, 0, 0), b: new V3(s * 5.5, nh + 0.12, 0), radius: 0.05, part: "post" }));
    }
    return out;
  },

  /** The ray passes through the net mesh (between the bands and the antennas) before reaching `distance`. */
  crossesMesh(o: V3, d: V3, distance: number, nh: number): boolean {
    if (!(Math.abs(d.z) > 1e-9)) return false;
    const t = -o.z / d.z;
    if (!(t > 0 && t < distance)) return false;
    const p = o.add(d.mul(t));
    return Math.abs(p.x) < 4.5 && p.y > nh - 1 && p.y < nh;
  },
};

/**
 * Line of sight to a target sphere (Section 5.6): 16 rays from the eye to well-spread points on the target's disc;
 * a ray is visible if its first hit is farther than the target.
 */
export class Visibility {
  constructor(
    readonly fraction: number,
    /** The occluder that blocks the most rays, for the readout. */
    readonly blocker: Capsule | undefined,
    /** Where the central ray (or the first blocked ray) is first occluded. */
    readonly occlusionPoint: V3 | undefined,
    readonly throughNet: boolean,
  ) {}

  /** "27% visible — blocked by #14 left forearm", or "visible" / "visible through net". */
  get readout(): string {
    const pct = swiftRound(this.fraction * 100);
    if (this.blocker && pct < 100) return `${pct}% visible — blocked by ${this.blocker.title}`;
    return this.throughNet ? `${pct}% visible through net` : `${pct}% visible`;
  }
}

function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = b.sub(a);
  const l2 = ab.dot(ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, p.sub(a).dot(ab) / l2)) : 0;
  return p.sub(a.add(ab.mul(t))).length;
}

export const LineOfSight = {
  /** Unit-disc sample points: a golden-angle (Vogel) spiral, an even, deterministic stand-in for Poisson disc samples. */
  disc: Array.from({ length: 16 }, (_, i): [number, number] => {
    const r = Math.sqrt((i + 0.5) / 16);
    const a = i * 2.399963229728653;
    return [r * Math.cos(a), r * Math.sin(a)];
  }) as readonly (readonly [number, number])[],

  /**
   * `viewer` is the POV player: their own head and torso never occlude (the eye sits there), but their arms and hands
   * do, so a blocker sees their own hands. Capsules of `targetOwner` that overlap the target are skipped.
   */
  visibility(eye: V3, target: V3, radius: number, occluders0: readonly Capsule[],
    options: { netHeight?: number; viewer?: string; targetOwner?: string } = {}): Visibility {
    const netHeight = options.netHeight ?? 2.43, viewer = options.viewer, targetOwner = options.targetOwner;
    const occluders = occluders0.filter((c) => {
      if (viewer !== undefined && c.owner === viewer && (c.part === "head" || c.part === "torso")) return false;
      if (targetOwner !== undefined && c.owner === targetOwner && segmentDistance(target, c.a, c.b) < c.radius + radius) return false;
      return true;
    });
    const axis = target.sub(eye).normalized;
    const ref = Math.abs(axis.y) < 0.9 ? V3.up : new V3(1, 0, 0);
    const u = axis.cross(ref).normalized, v = axis.cross(u);
    let visible = 0;
    const counts = new Map<string, { capsule: Capsule; count: number }>();
    let occlusion: V3 | undefined;
    let throughNet = false;
    LineOfSight.disc.forEach(([x, y], i) => {
      const p = target.add(u.mul(x * radius)).add(v.mul(y * radius));
      const d = p.sub(eye).normalized;
      const dist = p.sub(eye).length;
      let first: [number, Capsule] | undefined;
      for (const c of occluders) {
        const t = c.intersect(eye, d);
        if (t !== undefined && t < dist - 1e-6 && t < (first?.[0] ?? Infinity)) first = [t, c];
      }
      if (first) {
        const [t, c] = first;
        const entry = counts.get(c.key);
        if (entry) entry.count += 1;
        else counts.set(c.key, { capsule: c, count: 1 });
        if (occlusion === undefined || i === 0) occlusion = eye.add(d.mul(t));
      } else {
        visible += 1;
        if (OccluderModel.crossesMesh(eye, d, dist, netHeight)) throughNet = true;
      }
    });
    let blocker: Capsule | undefined;
    let most = 0;
    for (const { capsule, count } of counts.values()) {
      if (blocker === undefined || count > most) {
        blocker = capsule;
        most = count;
      }
    }
    return new Visibility(visible / LineOfSight.disc.length, blocker, occlusion, throughNet);
  },

  segmentDistance,
};

/** The three visual-field bands of Section 5.7 around the head-forward direction. */
export type VisualBand = "foveal" | "central" | "peripheral" | "outside";

export class VisualField {
  /** Half-angles in degrees. */
  foveal = 2.5;
  central = 30.0;
  peripheralHorizontal = 90.0;
  peripheralUp = 50.0;
  peripheralDown = 70.0;

  /**
   * The band of a direction and its angle from forward (degrees). Foveal and central are cones; the peripheral limit
   * is an ellipse in (horizontal, vertical) angle with the upper or lower vertical limit by sign.
   */
  classify(direction: V3, f: V3, up: V3): { band: VisualBand; angle: number } {
    const u = direction.normalized, fw = f.normalized;
    const right = fw.cross(up).normalized;
    const w = right.cross(fw);
    const angle = (Math.acos(Math.max(-1, Math.min(1, u.dot(fw)))) * 180) / Math.PI;
    if (angle <= this.foveal) return { band: "foveal", angle };
    if (angle <= this.central) return { band: "central", angle };
    const th = (Math.atan2(u.dot(right), u.dot(fw)) * 180) / Math.PI;
    const tv = (Math.atan2(u.dot(w), Math.sqrt(u.dot(fw) * u.dot(fw) + u.dot(right) * u.dot(right))) * 180) / Math.PI;
    const av = tv >= 0 ? this.peripheralUp : this.peripheralDown;
    const e = (th / this.peripheralHorizontal) * (th / this.peripheralHorizontal) + (tv / av) * (tv / av);
    return { band: e <= 1 ? "peripheral" : "outside", angle };
  }
}
