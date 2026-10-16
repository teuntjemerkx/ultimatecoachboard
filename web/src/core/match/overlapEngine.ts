// Port of Rules/OverlapEngine.swift: footprints, the seven overlap constraints and formation legality.
import { type JsonValue, JsonReader } from "./codable";
import type { CourtPosition, LocalPoint } from "./court";
import type { RuleCourtProfile } from "./ruleCourtProfile";

/** How a player stands, in the team-local frame. Yaw 0 means facing the net (forward = -d). */
export interface Stance {
  yaw: number;
  width: number;
  stagger: number;
}

export const Stance = {
  make({ yaw = 0, width = 0.30, stagger = 0 }: Partial<Stance> = {}): Stance {
    return { yaw, width, stagger };
  },

  ready: Object.freeze({ yaw: 0, width: 0.30, stagger: 0 }) as Readonly<Stance>,

  encode(s: Stance): JsonValue {
    return { yaw: s.yaw, width: s.width, stagger: s.stagger };
  },

  decode(json: unknown, what = "Stance"): Stance {
    const r = new JsonReader(json, what);
    return { yaw: r.num("yaw"), width: r.num("width"), stagger: r.num("stagger") };
  },
};

/** The extreme points of a player's two feet (blueprint Section 3.4.1). */
export interface FootExtremes {
  /** Distance of the foremost part of any foot to the centre line. */
  d: number;
  /** Distance of the outermost part of any foot to the team's left sideline. */
  left: number;
  /** Distance of the outermost part of any foot to the team's right sideline. */
  right: number;
  /** Deepest part of any foot (used for the inside-court and envelope checks). */
  maxD: number;
  witnessD: LocalPoint;
  witnessLeft: LocalPoint;
  witnessRight: LocalPoint;
}

export const Footprint = {
  /**
   * The eight vertices of the two feet, each a `footLength` x `footWidth` rectangle.
   * Mirrors the executable reference used to verify the engine (Appendix D2).
   */
  vertices(c: LocalPoint, s: Readonly<Stance>, footLength = 0.28, footWidth = 0.10): LocalPoint[] {
    const fwd = { l: Math.sin(s.yaw), d: -Math.cos(s.yaw) };
    const rgt = { l: Math.cos(s.yaw), d: Math.sin(s.yaw) };
    const out: LocalPoint[] = [];
    for (const [side, stag] of [[-1.0, s.stagger / 2], [1.0, -s.stagger / 2]]) {
      const fl = c.l + rgt.l * side * s.width / 2 + fwd.l * stag;
      const fd = c.d + rgt.d * side * s.width / 2 + fwd.d * stag;
      for (const a of [-1.0, 1.0]) {
        for (const b of [-1.0, 1.0]) {
          out.push({ l: fl + fwd.l * a * footLength / 2 + rgt.l * b * footWidth / 2,
                     d: fd + fwd.d * a * footLength / 2 + rgt.d * b * footWidth / 2 });
        }
      }
    }
    return out;
  },

  extremes(center: LocalPoint, stance: Readonly<Stance>, footLength = 0.28, footWidth = 0.10,
           courtWidth = 9.0): FootExtremes {
    const v = Footprint.vertices(center, stance, footLength, footWidth);
    const e: FootExtremes = { d: Infinity, left: Infinity, right: Infinity, maxD: -Infinity,
                              witnessD: center, witnessLeft: center, witnessRight: center };
    for (const p of v) {
      if (p.d < e.d) { e.d = p.d; e.witnessD = p; }
      if (p.l < e.left) { e.left = p.l; e.witnessLeft = p; }
      const r = courtWidth - p.l;
      if (r < e.right) { e.right = r; e.witnessRight = p; }
      e.maxD = Math.max(e.maxD, p.d);
    }
    return e;
  },
};

/**
 * - `frontBack`: the front-row player must be nearer the centre line than the back-row player behind.
 * - `leftCentre`: the left player must be nearer the left sideline than the centre player of the row.
 * - `rightCentre`: the right player must be nearer the right sideline than the centre player of the row.
 */
export type ConstraintKind = "frontBack" | "leftCentre" | "rightCentre";

export interface ConstraintResult {
  a: CourtPosition;
  b: CourtPosition;
  kind: ConstraintKind;
  /** Positive margin = legal, in metres (blueprint Section 3.4.2). */
  margin: number;
  witnessA: LocalPoint;
  witnessB: LocalPoint;
}

export const ConstraintResult = {
  isLegal(r: ConstraintResult): boolean {
    return r.margin > 0;
  },
};

export declare namespace OverlapEngine {
  interface Options {
    footLength: number;
    footWidth: number;
    courtWidth: number;
  }
}

/** Player centres (or stances) by court position. */
export type Positions = ReadonlyMap<CourtPosition, LocalPoint>;
export type Stances = ReadonlyMap<CourtPosition, Readonly<Stance>>;

const noStances: Stances = new Map();

function makeOptions({ footLength = 0.28, footWidth = 0.10, courtWidth = 9.0 }: Partial<OverlapEngine.Options> = {}):
  OverlapEngine.Options {
  return { footLength, footWidth, courtWidth };
}

export const OverlapEngine = {
  /** The seven constraint pairs; `a` is the player who must be nearer the reference line. */
  pairs: [
    [4, 5, "frontBack"], [3, 6, "frontBack"], [2, 1, "frontBack"],
    [4, 3, "leftCentre"], [5, 6, "leftCentre"],
    [2, 3, "rightCentre"], [1, 6, "rightCentre"],
  ] as ReadonlyArray<readonly [CourtPosition, CourtPosition, ConstraintKind]>,

  /** Swift `Options(footLength:footWidth:courtWidth:)`. */
  options: makeOptions,

  /** Swift `Options(profile:)`. */
  optionsFor(profile: RuleCourtProfile): OverlapEngine.Options {
    return { footLength: profile.overlap.footprint.footLength, footWidth: profile.overlap.footprint.footWidth,
             courtWidth: profile.court.width };
  },

  extremes(positions: Positions, stances: Stances, options: OverlapEngine.Options): Map<CourtPosition, FootExtremes> {
    const out = new Map<CourtPosition, FootExtremes>();
    for (const [p, c] of positions) {
      out.set(p, Footprint.extremes(c, stances.get(p) ?? Stance.ready, options.footLength, options.footWidth,
                                    options.courtWidth));
    }
    return out;
  },

  /**
   * Evaluates every applicable constraint. When `serving` is true and the server is exempt, every pair containing
   * P1 is dropped (blueprint Section 3.4.3).
   */
  evaluate(positions: Positions, { stances = noStances, serving, serverExempt = true, options = makeOptions() }:
           { stances?: Stances; serving: boolean; serverExempt?: boolean; options?: OverlapEngine.Options }): ConstraintResult[] {
    const ex = OverlapEngine.extremes(positions, stances, options);
    const results: ConstraintResult[] = [];
    for (const [a, b, kind] of OverlapEngine.pairs) {
      if (serving && serverExempt && (a === 1 || b === 1)) continue;
      const ea = ex.get(a);
      const eb = ex.get(b);
      if (ea === undefined || eb === undefined) continue;
      switch (kind) {
        case "frontBack":
          results.push({ a, b, kind, margin: eb.d - ea.d, witnessA: ea.witnessD, witnessB: eb.witnessD });
          break;
        case "leftCentre":
          results.push({ a, b, kind, margin: eb.left - ea.left, witnessA: ea.witnessLeft, witnessB: eb.witnessLeft });
          break;
        case "rightCentre":
          results.push({ a, b, kind, margin: eb.right - ea.right, witnessA: ea.witnessRight, witnessB: eb.witnessRight });
          break;
      }
    }
    return results;
  },

  /** Whether a whole formation is legal under a profile, including the inside-court rule. */
  isLegal(positions: Positions, { stances = noStances, serving, profile }:
          { stances?: Stances; serving: boolean; profile: RuleCourtProfile }): boolean {
    const checked = serving ? profile.overlap.checkServingTeam : profile.overlap.checkReceivingTeam;
    if (!checked) return true;
    const options = OverlapEngine.optionsFor(profile);
    const results = OverlapEngine.evaluate(positions, { stances, serving, serverExempt: profile.overlap.serverExempt, options });
    if (!results.every(ConstraintResult.isLegal)) return false;
    if (profile.overlap.requireInsideCourt) {
      for (const [p, c] of positions) {
        if (serving && profile.overlap.serverExempt && p === 1) continue;
        const verts = Footprint.vertices(c, stances.get(p) ?? Stance.ready, options.footLength, options.footWidth);
        if (verts.some((v) => v.l < 0 || v.l > profile.court.width || v.d < 0 || v.d > profile.court.length / 2)) {
          return false;
        }
      }
    }
    return true;
  },

  /** Server position at contact (or take-off): behind the end line, between the sideline extensions. */
  serverPositionIsLegal(center: LocalPoint, { stance = Stance.ready, profile }:
                        { stance?: Readonly<Stance>; profile: RuleCourtProfile }): boolean {
    const half = profile.court.length / 2;
    const verts = Footprint.vertices(center, stance, profile.overlap.footprint.footLength,
                                     profile.overlap.footprint.footWidth);
    return verts.every((v) => v.d > half && v.l >= 0 && v.l <= profile.court.width);
  },

  /** The smallest margin of a formation (positive = legal with that much to spare). */
  minimumMargin(positions: Positions, { stances = noStances, serving, options = makeOptions() }:
                { stances?: Stances; serving: boolean; options?: OverlapEngine.Options }): number {
    const margins = OverlapEngine.evaluate(positions, { stances, serving, options }).map((r) => r.margin);
    return margins.length === 0 ? Infinity : Math.min(...margins);
  },
};
