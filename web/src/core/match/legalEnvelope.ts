// Port of Rules/LegalEnvelope.swift.
import type { CourtPosition, LocalPoint } from "./court";
import { OverlapEngine, type Positions, type Stances } from "./overlapEngine";
import type { RuleCourtProfile } from "./ruleCourtProfile";

/**
 * The region in which a dragged player's centre keeps every applicable constraint legal (blueprint Section 3.4.5).
 * Every constraint is an axis-aligned half-plane in the player's centre coordinates, so the region is a rectangle.
 */
export interface LegalEnvelope {
  lMin: number;
  lMax: number;
  dMin: number;
  dMax: number;
  /** The neighbours whose constraints bound the region; when the region is empty these are the players to move first. */
  boundingNeighbours: Set<CourtPosition>;
}

type Bound = { l: number; d: number };
type Who = { lMin: Set<CourtPosition>; lMax: Set<CourtPosition>; dMin: Set<CourtPosition>; dMax: Set<CourtPosition> };

function union<T>(...sets: Set<T>[]): Set<T> {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

export const LegalEnvelope = {
  isEmpty(env: LegalEnvelope): boolean {
    return env.lMin >= env.lMax || env.dMin >= env.dMax;
  },

  contains(env: LegalEnvelope, p: LocalPoint): boolean {
    return p.l > env.lMin && p.l < env.lMax && p.d > env.dMin && p.d < env.dMax;
  },

  /** Computes the envelope for `player`, holding everyone else fixed. Swift `compute(for:positions:...)`. */
  compute(player: CourtPosition, { positions, stances = new Map(), serving, profile }:
          { positions: Positions; stances?: Stances; serving: boolean; profile: RuleCourtProfile }): LegalEnvelope {
    const options = OverlapEngine.optionsFor(profile);
    const width = profile.court.width;
    const halfLength = profile.court.length / 2;
    const ex = OverlapEngine.extremes(positions, stances, options);
    const centre = positions.get(player);
    const own = ex.get(player);
    if (centre === undefined || own === undefined) {
      return { lMin: 0, lMax: 0, dMin: 0, dMax: 0, boundingNeighbours: new Set() };
    }
    // Offsets from the centre to the player's own extreme foot points (fixed for the current stance).
    const eForward = centre.d - own.d;
    const eLeft = centre.l - own.left;
    const eRight = (width - centre.l) - own.right;
    const eBack = own.maxD - centre.d;

    const lo: Bound = { l: -Infinity, d: -Infinity };
    const hi: Bound = { l: Infinity, d: Infinity };
    const who: Who = { lMin: new Set(), lMax: new Set(), dMin: new Set(), dMax: new Set() };

    const tighten = (bound: Bound, axis: "l" | "d", value: number, isMax: boolean, neighbour: CourtPosition,
                     set: keyof Who) => {
      if (isMax ? value < bound[axis] : value > bound[axis]) {
        bound[axis] = value;
        who[set] = new Set([neighbour]);
      } else if (value === bound[axis]) {
        who[set].add(neighbour);
      }
    };

    const checked = serving ? profile.overlap.checkServingTeam : profile.overlap.checkReceivingTeam;
    if (checked) {
      for (const [a, b, kind] of OverlapEngine.pairs) {
        if (serving && profile.overlap.serverExempt && (a === 1 || b === 1)) continue;
        if (a !== player && b !== player) continue;
        const other = a === player ? b : a;
        const eo = ex.get(other);
        if (eo === undefined) continue;
        switch (kind) {
          case "frontBack":
            if (a === player) tighten(hi, "d", eo.d + eForward, true, other, "dMax");   // nearer the centre line than `other`
            else tighten(lo, "d", eo.d + eForward, false, other, "dMin");              // deeper than `other`
            break;
          case "leftCentre":
            if (a === player) tighten(hi, "l", eo.left + eLeft, true, other, "lMax");   // the left player
            else tighten(lo, "l", eo.left + eLeft, false, other, "lMin");              // the centre player
            break;
          case "rightCentre":
            if (a === player) tighten(lo, "l", width - eRight - eo.right, false, other, "lMin");   // the right player
            else tighten(hi, "l", width - eRight - eo.right, true, other, "lMax");                // the centre player
            break;
        }
      }
    }

    if (profile.overlap.requireInsideCourt && !(serving && profile.overlap.serverExempt && player === 1)) {
      lo.l = Math.max(lo.l, eLeft);
      hi.l = Math.min(hi.l, width - eRight);
      lo.d = Math.max(lo.d, eForward);
      hi.d = Math.min(hi.d, halfLength - eBack);
    }

    const env: LegalEnvelope = { lMin: lo.l, lMax: hi.l, dMin: lo.d, dMax: hi.d, boundingNeighbours: new Set() };
    if (LegalEnvelope.isEmpty(env)) {
      if (env.lMin >= env.lMax) env.boundingNeighbours = union(env.boundingNeighbours, who.lMin, who.lMax);
      if (env.dMin >= env.dMax) env.boundingNeighbours = union(env.boundingNeighbours, who.dMin, who.dMax);
    } else {
      env.boundingNeighbours = union(who.lMin, who.lMax, who.dMin, who.dMax);
    }
    return env;
  },
};
