// Port of Store/SkillCoding.swift: the Advanced Mode coding pad's skills, grades, codes, tables and predictor.
import { type JsonValue, JsonReader, decodeRaw, decodeUUID } from "./codable";
import { Side } from "./court";
import { type PlayerID, Score } from "./matchState";

const skills = { serve: "S", reception: "R", set: "E", attack: "A", block: "B", dig: "D", freeball: "F" } as const;

/** Skills of the Advanced Mode coding pad (Appendix C2, Screen 4), in the usual scouting letters (the raw values). */
export type Skill = (typeof skills)[keyof typeof skills];

export const Skill = {
  ...skills,
  allCases: Object.values(skills) as readonly Skill[],

  name(s: Skill): string {
    switch (s) {
      case "S": return "Serve";
      case "R": return "Reception";
      case "E": return "Set";
      case "A": return "Attack";
      case "B": return "Block";
      case "D": return "Dig";
      case "F": return "Free ball";
    }
  },

  decode(json: unknown, what = "Skill"): Skill {
    return decodeRaw(json, what, Skill.allCases);
  },
};

const grades = { perfect: "#", positive: "+", fair: "!", negative: "-", poor: "/", error: "=" } as const;

/**
 * Grades from best to worst: # perfect (ace, kill, perfect pass), + positive, ! fair, - negative,
 * / poor (overpass, blocked), = error. The raw values are those characters.
 */
export type SkillGrade = (typeof grades)[keyof typeof grades];

export const SkillGrade = {
  ...grades,
  allCases: Object.values(grades) as readonly SkillGrade[],

  /** The character shown on chips (a true minus sign for the negative grade). */
  symbol(g: SkillGrade): string {
    return g === "-" ? "−" : g;
  },

  decode(json: unknown, what = "SkillGrade"): SkillGrade {
    return decodeRaw(json, what, SkillGrade.allCases);
  },
};

/** One coded touch (journal type 0x000D), with the rally context it was coded in. */
export interface SkillCode {
  side: Side;
  player: PlayerID;
  skill: Skill;
  grade: SkillGrade;
  setNumber: number;
  /** Score when the touch was coded, which is the score before the rally it belongs to. */
  score: Score;
  homeRotation: number;
  opponentRotation: number;
}

export const SkillCode = {
  /** The scouting code, e.g. "A#". */
  code(c: SkillCode): string {
    return c.skill + c.grade;
  },

  encode(c: SkillCode): JsonValue {
    return { side: c.side, player: c.player, skill: c.skill, grade: c.grade, setNumber: c.setNumber,
             score: Score.encode(c.score), homeRotation: c.homeRotation, opponentRotation: c.opponentRotation };
  },

  decode(json: unknown, what = "SkillCode"): SkillCode {
    const r = new JsonReader(json, what);
    return { side: r.req("side", Side.decode), player: r.req("player", decodeUUID), skill: r.req("skill", Skill.decode),
             grade: r.req("grade", SkillGrade.decode), setNumber: r.int("setNumber"), score: r.req("score", Score.decode),
             homeRotation: r.int("homeRotation"), opponentRotation: r.int("opponentRotation") };
  },
};

/** One player's line in a skill table. */
export interface SkillLine {
  counts: Partial<Record<SkillGrade, number>>;
}

export const SkillLine = {
  make(): SkillLine {
    return { counts: {} };
  },

  total(line: SkillLine): number {
    return Object.values(line.counts).reduce((a: number, b) => a + (b ?? 0), 0);
  },

  count(line: SkillLine, g: SkillGrade): number {
    return line.counts[g] ?? 0;
  },

  /** Share of # and + touches. */
  positiveRate(line: SkillLine): number | undefined {
    const total = SkillLine.total(line);
    return total === 0 ? undefined : (SkillLine.count(line, "#") + SkillLine.count(line, "+")) / total;
  },

  /** (# - / - =) / total: kills minus blocked and errors for attacks, aces minus errors for serves. */
  efficiency(line: SkillLine): number | undefined {
    const total = SkillLine.total(line);
    return total === 0 ? undefined
      : (SkillLine.count(line, "#") - SkillLine.count(line, "/") - SkillLine.count(line, "=")) / total;
  },
};

function tally(line: SkillLine, grade: SkillGrade): void {
  line.counts[grade] = (line.counts[grade] ?? 0) + 1;
}

export const SkillStats = {
  /** Per player and skill, over one set or (with `setNumber` undefined) the whole match. */
  table(codes: readonly SkillCode[], side: Side, setNumber?: number): Record<PlayerID, Partial<Record<Skill, SkillLine>>> {
    const out: Record<PlayerID, Partial<Record<Skill, SkillLine>>> = {};
    for (const c of codes) {
      if (c.side !== side || (setNumber !== undefined && c.setNumber !== setNumber)) continue;
      const bySkill = Object.prototype.hasOwnProperty.call(out, c.player) ? out[c.player] : (out[c.player] = {});
      tally(bySkill[c.skill] ??= SkillLine.make(), c.grade);
    }
    return out;
  },

  /** Team totals per skill. */
  team(codes: readonly SkillCode[], side: Side, setNumber?: number): Partial<Record<Skill, SkillLine>> {
    const out: Partial<Record<Skill, SkillLine>> = {};
    for (const c of codes) {
      if (c.side !== side || (setNumber !== undefined && c.setNumber !== setNumber)) continue;
      tally(out[c.skill] ??= SkillLine.make(), c.grade);
    }
    return out;
  },
};

export const SkillPredictor = {
  /**
   * The skill a coach most likely codes next for this player, so the common case is a single tap on a grade: the
   * server serves; the receiving team's first touch is a reception; after a reception or dig the setter sets and
   * everyone else attacks; after the other side attacks, front-row players block and others dig.
   */
  next({ side, isServer, isFrontRow, role, serving, codesThisRally }: {
    side: Side; isServer: boolean; isFrontRow: boolean; role?: string; serving: Side; codesThisRally: readonly SkillCode[];
  }): Skill {
    if (isServer && codesThisRally.length === 0) return "S";
    // Before any code: the receiving team receives; the serving team's other players defend next.
    const last = codesThisRally[codesThisRally.length - 1];
    if (last === undefined) return side === serving ? (isFrontRow ? "B" : "D") : "R";
    const isSetter = role?.startsWith("S") ?? false;
    if (last.side === side) {
      switch (last.skill) {
        case "R": case "D": case "F": return isSetter ? "E" : "A";
        case "E": return "A";
        case "S": case "A": case "B": return "D";
      }
    }
    switch (last.skill) {
      case "S": return "R";
      case "A": case "E": return isFrontRow ? "B" : "D";
      case "F": return "F";
      default: return "D";
    }
  },
};
