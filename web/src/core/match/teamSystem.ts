// Port of Templates/TeamSystem.swift: the playing systems and the LineupBuilder. (The TemplateLibrary and
// RotationTemplate extensions of that file live in rotationTemplate.ts.)
import { type JsonValue, decodeRaw } from "./codable";
import { CourtPosition } from "./court";
import { type PlayerID, TeamSheet } from "./matchState";

const systems = {
  fiveOneOutside: "5-1-outside-follows-setter",
  fiveOneMiddle: "5-1-middle-follows-setter",
  sixTwo: "6-2",
  fourTwo: "4-2",
  youthW: "youth-w",
} as const;

/** The playing systems Match Setup offers (Appendix C2, Screen 2), each backed by a verified template. Raw value = template id. */
export type TeamSystem = (typeof systems)[keyof typeof systems];

export const TeamSystem = {
  ...systems,
  allCases: [systems.fiveOneOutside, systems.fiveOneMiddle, systems.sixTwo, systems.fourTwo, systems.youthW] as readonly TeamSystem[],

  /** Swift `TeamSystem(rawValue:)`. */
  fromRawValue(raw: string): TeamSystem | undefined {
    return TeamSystem.allCases.find((s) => s === raw);
  },

  templateID(s: TeamSystem): string {
    return s;
  },

  displayName(s: TeamSystem): string {
    switch (s) {
      case "5-1-outside-follows-setter": return "5-1 · outside follows setter";
      case "5-1-middle-follows-setter": return "5-1 · middle follows setter";
      case "6-2": return "6-2";
      case "4-2": return "4-2";
      case "youth-w": return "Youth W";
    }
  },

  /** Display names of the roles in rotational order (index 0 names the rotation). */
  roleNames(s: TeamSystem): string[] {
    switch (s) {
      case "5-1-outside-follows-setter": return ["Setter", "Outside 1", "Middle 1", "Opposite", "Outside 2", "Middle 2"];
      case "5-1-middle-follows-setter": return ["Setter", "Middle 1", "Outside 1", "Opposite", "Middle 2", "Outside 2"];
      case "6-2":
      case "4-2": return ["Setter 1", "Outside 1", "Middle 1", "Setter 2", "Outside 2", "Middle 2"];
      case "youth-w": return ["Player A", "Player B", "Player C", "Player D", "Player E", "Player F"];
    }
  },

  /** True when the first role is a setter, so the coach marks who sets. */
  hasSetter(s: TeamSystem): boolean {
    return s !== "youth-w";
  },

  encode(s: TeamSystem): JsonValue {
    return s;
  },

  decode(json: unknown, what = "TeamSystem"): TeamSystem {
    return decodeRaw(json, what, TeamSystem.allCases);
  },
};

/** Builds team sheets from players placed on court positions (Match Setup's position slots). */
export const LineupBuilder = {
  /**
   * Roles by court position when the template's first role stands in `anchor`: P_i holds order[(i - anchor) mod 6],
   * the convention of Appendix A.
   */
  roles(order: readonly string[], anchor: CourtPosition): Map<CourtPosition, string> {
    if (order.length !== 6) throw new Error("a lineup order has six roles");
    const out = new Map<CourtPosition, string>();
    for (const pos of CourtPosition.allCases) out.set(pos, order[((pos - anchor) % 6 + 6) % 6]);
    return out;
  },

  /**
   * A team sheet from players by position, with roles derived from the lineup order and the libero partners taken
   * from the template's libero rule.
   */
  sheet({ players, order, anchor, libero, liberoReplaces }: {
    players: ReadonlyMap<CourtPosition, PlayerID>;
    order: readonly string[];
    anchor: CourtPosition;
    libero?: PlayerID;
    liberoReplaces: readonly string[];
  }): TeamSheet {
    const roleByPosition = LineupBuilder.roles(order, anchor);
    const lineup = CourtPosition.allCases.map((pos) => {
      const id = players.get(pos);
      if (id === undefined) throw new Error(`no player placed on ${CourtPosition.label(pos)}`);
      return id;
    });
    const roles: Record<PlayerID, string> = {};
    const partners = new Set<PlayerID>();
    for (const [pos, id] of players) {
      const role = roleByPosition.get(pos)!;
      roles[id] = role;
      if (liberoReplaces.includes(role)) partners.add(id);
    }
    let liberos: PlayerID[] = [];
    if (libero !== undefined) {
      liberos = [libero];
      roles[libero] = "L";
    }
    return TeamSheet.make({ startingLineup: lineup, roles, liberos,
                            liberoPartners: liberos.length === 0 ? [] : partners });
  },
};
