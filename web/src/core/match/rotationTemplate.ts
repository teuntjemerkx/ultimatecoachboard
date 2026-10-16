// Port of Templates/RotationTemplate.swift, the TemplateLibrary and RotationTemplate extensions of
// Templates/TeamSystem.swift, and the RotationTemplate rotation helpers of Zones/SceneAutopilot.swift
// (`rotations`, `nextRotation(after:)`, `previousRotation(before:)`).
import fourTwoJSON from "../resources/templates/4-2.json";
import middleJSON from "../resources/templates/5-1-middle-follows-setter.json";
import outsideJSON from "../resources/templates/5-1-outside-follows-setter.json";
import youthJSON from "../resources/templates/youth-w.json";
import {
  type JsonValue, JsonReader, compact, decodeArray, decodeNumber, decodeString, decodeStringDictionary,
} from "./codable";
import { CourtPosition, LocalPoint, type Side } from "./court";
import type { MatchState } from "./matchState";
import { ConstraintResult, OverlapEngine } from "./overlapEngine";
import type { RuleCourtProfile } from "./ruleCourtProfile";
import { TeamSystem } from "./teamSystem";

/** A rotation template file (Appendix B5, format "cb.rotation-template/1"). */
export interface RotationTemplate {
  format: string;
  id: string;
  system: string;
  lineupOrder: string[];
  libero?: RotationTemplate.Libero;
  setterTarget: number[];
  routeTargets: Record<string, number[]>;
  baseSlots?: Record<string, number[]>;
  formations: RotationTemplate.Formation[];
  note?: string;
}

export declare namespace RotationTemplate {
  interface Libero {
    replaces: string[];
    whenServing: boolean;
  }

  interface Player {
    role: string;
    position: number;
    anchor: number[];
    passes: boolean;
    route?: string;
    switchTo?: number[];
  }

  interface Formation {
    rotation: number;
    phase: string;
    players: Player[];
    expectedMinMargin?: number;
    frontSetterPosition?: number;
    note?: string;
  }
}

type Formation = RotationTemplate.Formation;
type Player = RotationTemplate.Player;

function decodePlayer(json: unknown, what: string): Player {
  const r = new JsonReader(json, what);
  return { role: r.str("role"), position: r.int("position"), anchor: r.array("anchor", decodeNumber),
           passes: r.bool("passes"), route: r.optStr("route"), switchTo: r.optArray("switchTo", decodeNumber) };
}

function decodeFormation(json: unknown, what: string): Formation {
  const r = new JsonReader(json, what);
  return { rotation: r.int("rotation"), phase: r.str("phase"), players: r.array("players", decodePlayer),
           expectedMinMargin: r.optNum("expectedMinMargin"), frontSetterPosition: r.optInt("frontSetterPosition"),
           note: r.optStr("note") };
}

const decodePairs = (j: unknown, w: string) => decodeStringDictionary(j, w, (v, vw) => decodeArray(v, vw, decodeNumber));

function clonePlayer(p: Player): Player {
  return { ...p, anchor: [...p.anchor], switchTo: p.switchTo === undefined ? undefined : [...p.switchTo] };
}

function cloneFormation(f: Formation): Formation {
  return { ...f, players: f.players.map(clonePlayer) };
}

function clonePairs(pairs: Record<string, number[]>): Record<string, number[]> {
  return Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, [...v]]));
}

function cloneTemplate(t: RotationTemplate): RotationTemplate {
  return { ...t, lineupOrder: [...t.lineupOrder],
           libero: t.libero === undefined ? undefined : { ...t.libero, replaces: [...t.libero.replaces] },
           setterTarget: [...t.setterTarget], routeTargets: clonePairs(t.routeTargets),
           baseSlots: t.baseSlots === undefined ? undefined : clonePairs(t.baseSlots),
           formations: t.formations.map(cloneFormation) };
}

function step(t: RotationTemplate, r: number, delta: number): number {
  const available = new Set(RotationTemplate.rotations(t));
  if (available.size <= 1 || !Number.isInteger(r) || r < 1 || r > 6) return r;
  let n = r;
  for (let i = 0; i < 6; i++) {
    n = ((n - 1 + delta) % 6 + 6) % 6 + 1;
    if (available.has(n)) return n;
  }
  return r;
}

export const RotationTemplate = {
  supportedFormat: "cb.rotation-template/1",

  /** The formation for a rotation and phase ("receive" or "serve"). Swift `formation(rotation:phase:)`. */
  formation(t: RotationTemplate, rotation: number, phase: string): Formation | undefined {
    return t.formations.find((f) => f.rotation === rotation && f.phase === phase);
  },

  /**
   * The formation a team stands in for this template's system (blueprint Section 2.6, Appendix A), or undefined
   * when the system defines none for that phase (the board then uses generic anchors).
   * Swift `formation(for:side:phase:)`.
   */
  formationFor(t: RotationTemplate, match: MatchState, side: Side, phase: string): Formation | undefined {
    switch (t.system) {
      case "6-2": {
        const back = match.positionsOfRoles(["S1", "S2"], side).find((p) => !CourtPosition.isFrontRow(p));
        return back === undefined ? undefined : RotationTemplate.formation(t, back, phase);
      }
      case "4-2": {
        if (phase !== "receive") return undefined;
        const front = match.positionsOfRoles(["S1", "S2"], side).find(CourtPosition.isFrontRow);
        return front === undefined ? undefined : RotationTemplate.formation(t, front, "receive");
      }
      case "youth-W":
        return phase === "receive" ? RotationTemplate.formation(t, 0, "receive") : undefined;
      default:
        return RotationTemplate.formation(t, match.rotationNumber(side), phase);
    }
  },

  /** Rotations the template has formations for, ascending. */
  rotations(t: RotationTemplate): number[] {
    return [...new Set(t.formations.map((f) => f.rotation))].sort((a, b) => a - b);
  },

  /**
   * The rotation after a side-out: the setter moves from P1 to P6, so R1 becomes R6, then R5 (the app names a
   * rotation by the setter's position). Rotations the template lacks are skipped. Swift `nextRotation(after:)`.
   */
  nextRotation(t: RotationTemplate, r: number): number {
    return step(t, r, -1);
  },

  /** Swift `previousRotation(before:)`. */
  previousRotation(t: RotationTemplate, r: number): number {
    return step(t, r, 1);
  },

  /** A player's court position, or undefined when its number is not 1...6. Swift `Player.courtPosition`. */
  courtPosition(p: Player): CourtPosition | undefined {
    return CourtPosition.fromRawValue(p.position);
  },

  /** A player's anchor as a point. Swift `Player.point`. */
  point(p: Player): LocalPoint {
    return LocalPoint.fromPair(p.anchor);
  },

  /** Swift `Formation.isServing`. */
  isServing(f: Formation): boolean {
    return f.phase === "serve";
  },

  /** Anchors by court position. Swift `Formation.positions`. */
  positions(f: Formation): Map<CourtPosition, LocalPoint> {
    const out = new Map<CourtPosition, LocalPoint>();
    for (const p of f.players) {
      const cp = RotationTemplate.courtPosition(p);
      if (cp !== undefined) out.set(cp, RotationTemplate.point(p));
    }
    return out;
  },

  /** A deep copy. */
  clone: cloneTemplate,
  cloneFormation,

  encode(t: RotationTemplate): JsonValue {
    const player = (p: Player): JsonValue => compact({ role: p.role, position: p.position, anchor: [...p.anchor],
                                                       passes: p.passes, route: p.route, switchTo: p.switchTo && [...p.switchTo] });
    const formation = (f: Formation): JsonValue => compact({
      rotation: f.rotation, phase: f.phase, players: f.players.map(player), expectedMinMargin: f.expectedMinMargin,
      frontSetterPosition: f.frontSetterPosition, note: f.note,
    });
    return compact({
      format: t.format, id: t.id, system: t.system, lineupOrder: [...t.lineupOrder],
      libero: t.libero && { replaces: [...t.libero.replaces], whenServing: t.libero.whenServing },
      setterTarget: [...t.setterTarget], routeTargets: clonePairs(t.routeTargets),
      baseSlots: t.baseSlots && clonePairs(t.baseSlots), formations: t.formations.map(formation), note: t.note,
    });
  },

  /** Structural decoding only (Swift's synthesized Decodable); TemplateLibrary.decode also validates. */
  decode(json: unknown, what = "RotationTemplate"): RotationTemplate {
    const r = new JsonReader(json, what);
    return {
      format: r.str("format"),
      id: r.str("id"),
      system: r.str("system"),
      lineupOrder: r.array("lineupOrder", decodeString),
      libero: r.opt("libero", (j, w) => {
        const l = new JsonReader(j, w);
        return { replaces: l.array("replaces", decodeString), whenServing: l.bool("whenServing") };
      }),
      setterTarget: r.array("setterTarget", decodeNumber),
      routeTargets: r.req("routeTargets", decodePairs),
      baseSlots: r.opt("baseSlots", decodePairs),
      formations: r.array("formations", decodeFormation),
      note: r.optStr("note"),
    };
  },
};

export type TemplateErrorKind = "resourceMissing" | "unsupportedFormat" | "invalid";

/** Swift `TemplateError`. */
export class TemplateError extends Error {
  constructor(readonly kind: TemplateErrorKind, readonly detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "TemplateError";
  }
}

export interface FormationValidation {
  rotation: number;
  phase: string;
  minMargin: number;
  isLegal: boolean;
  /** True when the file's `expectedMinMargin` matches the engine to the centimetre (or none is given). */
  matchesExpectation: boolean;
  failing: ConstraintResult[];
}

const shippedJSON: Readonly<Record<string, unknown>> = {
  "5-1-outside-follows-setter": outsideJSON,
  "5-1-middle-follows-setter": middleJSON,
  "4-2": fourTwoJSON,
  "youth-w": youthJSON,
};

export const TemplateLibrary = {
  shippedIDs: ["5-1-outside-follows-setter", "5-1-middle-follows-setter", "4-2", "youth-w"] as readonly string[],

  /** Decodes and checks a template from JSON text or an already parsed JSON value. */
  decode(data: unknown): RotationTemplate {
    const t = RotationTemplate.decode(typeof data === "string" ? JSON.parse(data) : data);
    if (t.format !== RotationTemplate.supportedFormat) throw new TemplateError("unsupportedFormat", t.format);
    for (const f of t.formations) {
      const positions = new Set(f.players.map(RotationTemplate.courtPosition).filter((p) => p !== undefined));
      if (positions.size !== f.players.length) {
        throw new TemplateError("invalid", `formation R${f.rotation} ${f.phase}: duplicate or invalid positions`);
      }
      if (!f.players.every((p) => p.anchor.length === 2)) {
        throw new TemplateError("invalid", `formation R${f.rotation} ${f.phase}: anchors need two coordinates`);
      }
    }
    return t;
  },

  /** A shipped template by id (a fresh copy on every call). */
  shipped(id: string): RotationTemplate {
    if (!Object.prototype.hasOwnProperty.call(shippedJSON, id)) throw new TemplateError("resourceMissing", `${id}.json`);
    return TemplateLibrary.decode(shippedJSON[id]);
  },

  allShipped(): RotationTemplate[] {
    return TemplateLibrary.shippedIDs.map(TemplateLibrary.shipped);
  },

  /** Validates every formation of a template against a profile (blueprint Section 2.6: load-time validation). */
  validate(template: RotationTemplate, profile: RuleCourtProfile): FormationValidation[] {
    const options = OverlapEngine.optionsFor(profile);
    return template.formations.map((f) => {
      const results = OverlapEngine.evaluate(RotationTemplate.positions(f), {
        serving: RotationTemplate.isServing(f), serverExempt: profile.overlap.serverExempt, options,
      });
      const minMargin = results.length === 0 ? Infinity : Math.min(...results.map((r) => r.margin));
      const matches = f.expectedMinMargin !== undefined ? Math.abs(f.expectedMinMargin - minMargin) < 0.005 : true;
      return { rotation: f.rotation, phase: f.phase, minMargin, isLegal: results.every(ConstraintResult.isLegal),
               matchesExpectation: matches, failing: results.filter((r) => !ConstraintResult.isLegal(r)) };
    });
  },

  /**
   * 6-2: the three rotations with a back-row setter reuse the verified 5-1 formations R1, R6 and R5 with the
   * off-setter in the opposite's place (Appendix A4). Swift `sixTwoFormation(backRowSetterAt:from:)`.
   */
  sixTwoFormation(position: CourtPosition, fiveOne: RotationTemplate): Formation | undefined {
    let rotation: number;
    switch (position) {
      case 1: rotation = 1; break;
      case 6: rotation = 6; break;
      case 5: rotation = 5; break;
      default: return undefined;
    }
    const source = RotationTemplate.formation(fiveOne, rotation, "receive");
    if (source === undefined) return undefined;
    const f = cloneFormation(source);
    for (const p of f.players) if (p.role === "OPP") p.role = "S2";
    for (const p of f.players) if (p.role === "S") p.role = "S1";
    f.note = `6-2 formation derived from 5-1 R${rotation}`;
    return f;
  },

  /** A template by id, including the 6-2, which is derived from the verified 5-1 (Appendix A4). */
  template(id: string): RotationTemplate {
    if (id === TeamSystem.sixTwo) return TemplateLibrary.sixTwo(TemplateLibrary.shipped(TeamSystem.fiveOneOutside));
    return TemplateLibrary.shipped(id);
  },

  /**
   * The 6-2: indexed by the back-row setter's position (1, 6 or 5), each formation is the 5-1 formation of that
   * rotation with the back-row setter as S1 and the front-row setter in the opposite's place.
   */
  sixTwo(fiveOne: RotationTemplate): RotationTemplate {
    const t = cloneTemplate(fiveOne);
    t.id = TeamSystem.sixTwo;
    t.system = "6-2";
    t.lineupOrder = ["S1", "OH1", "MB1", "S2", "OH2", "MB2"];
    t.formations = fiveOne.formations.filter((f) => [1, 6, 5].includes(f.rotation)).map((source) => {
      const f = cloneFormation(source);
      for (const p of f.players) {
        switch (p.role) {
          case "S": p.role = "S1"; break;
          case "OPP": p.role = "S2"; break;
          default: break;
        }
      }
      f.note = `6-2 formation derived from 5-1 R${f.rotation}`;
      return f;
    });
    t.note = "Indexed by the back-row setter's position; S1 is whichever setter is in the back row.";
    return t;
  },
};
