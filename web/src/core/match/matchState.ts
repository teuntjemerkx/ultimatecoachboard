// Port of Rotation/MatchState.swift: the rally-by-rally state machine behind the Point Swipe Wheel.
import {
  type JsonValue, JsonReader, compact, decodeFlatDictionary, decodeString, decodeUUID, encodeFlatDictionary,
} from "./codable";
import { CourtPosition, Side } from "./court";
import { type RuleCourtProfile, Scoring } from "./ruleCourtProfile";

/** Swift `PlayerID = UUID`, kept as its uuidString (upper case when made here, like Swift's encoder writes it). */
export type PlayerID = string;

/** A new player identifier (Swift `UUID()`). */
export function newPlayerID(): PlayerID {
  return globalThis.crypto.randomUUID().toUpperCase();
}

function own<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** The first key holding `value` (Swift `dict.first { $0.value == value }?.key`; JS keeps insertion order). */
function keyOf<V>(record: Readonly<Record<string, V>>, value: V): string | undefined {
  for (const [k, v] of Object.entries(record)) if (v === value) return k;
  return undefined;
}

export interface Score {
  home: number;
  opponent: number;
}

/** `score[side]` reads and writes a side's points (Swift's subscript). */
export const Score = {
  make(home = 0, opponent = 0): Score {
    return { home, opponent };
  },

  encode(s: Score): JsonValue {
    return { home: s.home, opponent: s.opponent };
  },

  decode(json: unknown, what = "Score"): Score {
    const r = new JsonReader(json, what);
    return { home: r.int("home"), opponent: r.int("opponent") };
  },
};

/** One team's roster facts that the rotation engine needs. */
export interface TeamSheet {
  /** Players at P1...P6 at the start of the set (index 0 = P1). */
  startingLineup: PlayerID[];
  /** Role names as used in templates ("S", "OH1", "MB1", "OPP", ...). */
  roles: Record<PlayerID, string>;
  liberos: PlayerID[];
  /** Players the libero automatically replaces in the back row (normally the two middles). */
  liberoPartners: Set<PlayerID>;
}

export const TeamSheet = {
  make({ startingLineup, roles = {}, liberos = [], liberoPartners = [] }: {
    startingLineup: readonly PlayerID[];
    roles?: Readonly<Record<PlayerID, string>>;
    liberos?: readonly PlayerID[];
    liberoPartners?: Iterable<PlayerID>;
  }): TeamSheet {
    if (startingLineup.length !== 6) throw new Error("a lineup has six players");
    return { startingLineup: [...startingLineup], roles: { ...roles }, liberos: [...liberos],
             liberoPartners: new Set(liberoPartners) };
  },

  role(sheet: TeamSheet, id: PlayerID): string | undefined {
    return own(sheet.roles, id);
  },

  clone(s: TeamSheet): TeamSheet {
    return { startingLineup: [...s.startingLineup], roles: { ...s.roles }, liberos: [...s.liberos],
             liberoPartners: new Set(s.liberoPartners) };
  },

  /** `roles` is a [UUID: String] dictionary, which Swift encodes as a flat [id, role, id, role, ...] array. */
  encode(s: TeamSheet): JsonValue {
    return {
      startingLineup: [...s.startingLineup],
      roles: encodeFlatDictionary(Object.entries(s.roles), (k) => k, (v) => v),
      liberos: [...s.liberos],
      liberoPartners: [...s.liberoPartners],
    };
  },

  decode(json: unknown, what = "TeamSheet"): TeamSheet {
    const r = new JsonReader(json, what);
    return {
      startingLineup: r.array("startingLineup", decodeUUID),
      roles: Object.fromEntries(r.req("roles", (j, w) => decodeFlatDictionary(j, w, decodeUUID, decodeString))),
      liberos: r.array("liberos", decodeUUID),
      liberoPartners: new Set(r.array("liberoPartners", decodeUUID)),
    };
  },
};

/** A team's rotational state inside one set. */
export interface TeamInSet {
  /** Rotational order as at the start of the set; substitutions replace a slot in place. */
  lineup: PlayerID[];
  /** The lineup the set started with; a slot's starter decides its role and libero rule after substitutions. */
  starters: PlayerID[];
  /** Side-out rotations performed in this set. */
  rotations: number;
  substitutionsUsed: number;
  /** Substitution partners in this set (starter <-> substitute), both directions. */
  partners: Record<PlayerID, PlayerID>;
  /** Players whose substitution pair is complete (the starter came back): no further substitution this set. */
  completed: Set<PlayerID>;
}

export const TeamInSet = {
  make(lineup: readonly PlayerID[]): TeamInSet {
    return { lineup: [...lineup], starters: [...lineup], rotations: 0, substitutionsUsed: 0, partners: {},
             completed: new Set() };
  },

  clone(t: TeamInSet): TeamInSet {
    return { lineup: [...t.lineup], starters: [...t.starters], rotations: t.rotations,
             substitutionsUsed: t.substitutionsUsed, partners: { ...t.partners }, completed: new Set(t.completed) };
  },

  /** The starter of the slot a player occupies now. Swift `starter(ofSlotHeldBy:)`. */
  starterOfSlotHeldBy(t: TeamInSet, id: PlayerID): PlayerID | undefined {
    const i = t.lineup.indexOf(id);
    return i < 0 ? undefined : t.starters[i];
  },

  /** Lineup mapping of blueprint Section 2.5: player(i, n) = L[(i - 1 + n) mod 6]. Swift `player(at:)`. */
  playerAt(t: TeamInSet, pos: CourtPosition): PlayerID {
    return t.lineup[(pos - 1 + t.rotations) % 6];
  },

  /** Swift `position(of:)`. */
  positionOf(t: TeamInSet, id: PlayerID): CourtPosition | undefined {
    return CourtPosition.allCases.find((p) => TeamInSet.playerAt(t, p) === id);
  },

  encode(t: TeamInSet): JsonValue {
    return {
      lineup: [...t.lineup], starters: [...t.starters], rotations: t.rotations, substitutionsUsed: t.substitutionsUsed,
      partners: encodeFlatDictionary(Object.entries(t.partners), (k) => k, (v) => v),
      completed: [...t.completed],
    };
  },

  decode(json: unknown, what = "TeamInSet"): TeamInSet {
    const r = new JsonReader(json, what);
    return {
      lineup: r.array("lineup", decodeUUID),
      starters: r.array("starters", decodeUUID),
      rotations: r.int("rotations"),
      substitutionsUsed: r.int("substitutionsUsed"),
      partners: Object.fromEntries(r.req("partners", (j, w) => decodeFlatDictionary(j, w, decodeUUID, decodeUUID))),
      completed: new Set(r.array("completed", decodeUUID)),
    };
  },
};

/** One set; `set[side]` is that side's TeamInSet (Swift's subscript). */
export interface SetState {
  number: number;
  score: Score;
  serving: Side;
  firstServer: Side;
  home: TeamInSet;
  opponent: TeamInSet;
  winner?: Side;
}

export const SetState = {
  clone(s: SetState): SetState {
    const out: SetState = { number: s.number, score: { ...s.score }, serving: s.serving, firstServer: s.firstServer,
                            home: TeamInSet.clone(s.home), opponent: TeamInSet.clone(s.opponent) };
    if (s.winner !== undefined) out.winner = s.winner;
    return out;
  },

  encode(s: SetState): JsonValue {
    return compact({ number: s.number, score: Score.encode(s.score), serving: s.serving, firstServer: s.firstServer,
                     home: TeamInSet.encode(s.home), opponent: TeamInSet.encode(s.opponent), winner: s.winner });
  },

  decode(json: unknown, what = "SetState"): SetState {
    const r = new JsonReader(json, what);
    const out: SetState = { number: r.int("number"), score: r.req("score", Score.decode), serving: r.req("serving", Side.decode),
                            firstServer: r.req("firstServer", Side.decode), home: r.req("home", TeamInSet.decode),
                            opponent: r.req("opponent", TeamInSet.decode) };
    const winner = r.opt("winner", Side.decode);
    if (winner !== undefined) out.winner = winner;
    return out;
  },
};

export interface RallyOutcome {
  winner: Side;
  sideOut: boolean;
  setEnded: boolean;
  matchEnded: boolean;
}

/**
 * Swift `MatchError`. `illegalSubstitution` is the FIVB pairing rule: a starter leaves and returns once, a
 * substitute only for the player it replaced.
 */
export type MatchErrorCode =
  | "matchOver" | "setOver" | "setNotOver" | "playerNotOnCourt" | "substitutionLimitReached" | "notALiberoChange"
  | "illegalSubstitution";

export class MatchError extends Error {
  constructor(readonly code: MatchErrorCode) {
    super(code);
    this.name = "MatchError";
  }
}

/** Swift `MatchState.PointStatus`. */
export type PointStatus = "setPoint" | "matchPoint";

/**
 * The rally-by-rally state machine behind the Point Swipe Wheel (blueprint Section 2.5).
 * A Swift value type: mutating methods change this instance; use `clone()` where Swift copies (`var probe = match`).
 */
export class MatchState {
  scoring!: Scoring;
  maxSubstitutionsPerSet!: number;
  liberoMayServe!: boolean;
  sheets!: Partial<Record<Side, TeamSheet>>;
  sets!: SetState[];
  setsWonHome!: number;
  setsWonOpponent!: number;

  constructor({ profile, home, opponent, firstServer }:
              { profile: RuleCourtProfile; home: TeamSheet; opponent: TeamSheet; firstServer: Side }) {
    this.scoring = { ...profile.scoring };
    this.maxSubstitutionsPerSet = profile.substitutions.maxPerSet;
    this.liberoMayServe = profile.libero.mayServe;
    this.sheets = { home: TeamSheet.clone(home), opponent: TeamSheet.clone(opponent) };
    this.sets = [{ number: 1, score: Score.make(), serving: firstServer, firstServer,
                   home: TeamInSet.make(home.startingLineup), opponent: TeamInSet.make(opponent.startingLineup) }];
    this.setsWonHome = 0;
    this.setsWonOpponent = 0;
  }

  /** A deep copy (Swift value semantics). */
  clone(): MatchState {
    const m = Object.create(MatchState.prototype) as MatchState;
    m.scoring = { ...this.scoring };
    m.maxSubstitutionsPerSet = this.maxSubstitutionsPerSet;
    m.liberoMayServe = this.liberoMayServe;
    m.sheets = {};
    for (const side of Side.allCases) {
      const sheet = this.sheets[side];
      if (sheet) m.sheets[side] = TeamSheet.clone(sheet);
    }
    m.sets = this.sets.map(SetState.clone);
    m.setsWonHome = this.setsWonHome;
    m.setsWonOpponent = this.setsWonOpponent;
    return m;
  }

  /** The set being played (the last one). Treat as read-only; the methods below change it. */
  get current(): SetState {
    return this.sets[this.sets.length - 1];
  }

  set current(value: SetState) {
    this.sets[this.sets.length - 1] = value;
  }

  setsWon(side: Side): number {
    return side === "home" ? this.setsWonHome : this.setsWonOpponent;
  }

  get isOver(): boolean {
    return this.setsWonHome === this.scoring.setsToWin || this.setsWonOpponent === this.scoring.setsToWin;
  }

  /** Applies one rally outcome: score, side-out rotation, serve, set and match end. Throws MatchError. */
  applyRally(winner: Side): RallyOutcome {
    if (this.isOver) throw new MatchError("matchOver");
    if (this.current.winner !== undefined) throw new MatchError("setOver");
    const set = SetState.clone(this.current);
    set.score[winner] += 1;
    const sideOut = winner !== set.serving;
    if (sideOut) {
      set[winner].rotations += 1;
      set.serving = winner;
    }
    const target = Scoring.targetPoints(this.scoring, set.number);
    const mine = set.score[winner];
    const theirs = set.score[Side.other(winner)];
    let setEnded = false;
    if (mine >= target && mine - theirs >= this.scoring.winBy) {
      set.winner = winner;
      setEnded = true;
      if (winner === "home") this.setsWonHome += 1;
      else this.setsWonOpponent += 1;
    }
    this.current = set;
    return { winner, sideOut, setEnded, matchEnded: this.isOver };
  }

  /**
   * Starts the next set. Without explicit lineups the starting lineups of the previous set are reused; without an
   * explicit first server the team that did not serve first in the previous set serves first.
   */
  startNextSet({ homeLineup, opponentLineup, firstServer }:
               { homeLineup?: readonly PlayerID[]; opponentLineup?: readonly PlayerID[]; firstServer?: Side } = {}): void {
    if (this.current.winner === undefined) throw new MatchError("setNotOver");
    if (this.isOver) throw new MatchError("matchOver");
    const previous = this.current;
    const server = firstServer ?? Side.other(previous.firstServer);
    const home = homeLineup ?? this.sheets.home?.startingLineup ?? previous.home.lineup;
    const opponent = opponentLineup ?? this.sheets.opponent?.startingLineup ?? previous.opponent.lineup;
    this.sets.push({ number: previous.number + 1, score: Score.make(), serving: server, firstServer: server,
                     home: TeamInSet.make(home), opponent: TeamInSet.make(opponent) });
  }

  /**
   * A regular substitution: `incoming` takes `outgoing`'s rotational slot. FIVB pairing: a starter may leave once and
   * come back once, into its own slot, and only for its substitute; then the pair is closed for the set.
   */
  substitute(side: Side, outgoing: PlayerID, incoming: PlayerID): void {
    const set = SetState.clone(this.current);
    const team = set[side];
    if (team.substitutionsUsed >= this.maxSubstitutionsPerSet) throw new MatchError("substitutionLimitReached");
    const slot = team.lineup.indexOf(outgoing);
    if (slot < 0) throw new MatchError("playerNotOnCourt");
    const liberos = this.sheets[side]?.liberos ?? [];
    if (team.lineup.includes(incoming) || liberos.includes(incoming) || liberos.includes(outgoing)
        || team.completed.has(outgoing) || team.completed.has(incoming)) {
      throw new MatchError("illegalSubstitution");
    }
    const partner = own(team.partners, outgoing);
    if (partner !== undefined) {
      if (partner !== incoming) throw new MatchError("illegalSubstitution");
      team.completed.add(outgoing);
      team.completed.add(incoming);
    } else {
      if (own(team.partners, incoming) !== undefined) throw new MatchError("illegalSubstitution");
      team.partners[outgoing] = incoming;
      team.partners[incoming] = outgoing;
    }
    team.lineup[slot] = incoming;
    team.substitutionsUsed += 1;
    this.current = set;
  }

  /** The role shown for a player: its own role, or the role of the starter whose slot it took. Swift `displayRole(of:side:)`. */
  displayRole(id: PlayerID, side: Side): string | undefined {
    const sheet = this.sheets[side];
    if (!sheet) return undefined;
    const role = TeamSheet.role(sheet, id);
    if (role !== undefined) return role;
    const starter = TeamInSet.starterOfSlotHeldBy(this.current[side], id);
    return starter === undefined ? undefined : TeamSheet.role(sheet, starter);
  }

  /** The bench: players listed for the team who are neither on court nor liberos. */
  bench(side: Side, listed: readonly PlayerID[]): PlayerID[] {
    const team = this.current[side];
    const liberos = this.sheets[side]?.liberos ?? [];
    const everyone = [...listed, ...(this.sheets[side]?.startingLineup ?? []), ...team.starters];
    const seen = new Set<PlayerID>();
    return everyone.filter((id) => {
      if (team.lineup.includes(id) || liberos.includes(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  /** Set point or match point for a side: winning the next rally would end the set (or the match). */
  pointStatus(side: Side): PointStatus | undefined {
    if (this.current.winner !== undefined || this.isOver) return undefined;
    const target = Scoring.targetPoints(this.scoring, this.current.number);
    const mine = this.current.score[side] + 1;
    const theirs = this.current.score[Side.other(side)];
    if (!(mine >= target && mine - theirs >= this.scoring.winBy)) return undefined;
    return this.setsWon(side) === this.scoring.setsToWin - 1 ? "matchPoint" : "setPoint";
  }

  /** Manual correction of a rotation or serving side (journal type 0x0012, Appendix C6). */
  correctRotation(side: Side, { setterPosition, rotations, serving }:
                  { setterPosition?: CourtPosition; rotations?: number; serving?: Side }): void {
    const set = SetState.clone(this.current);
    if (rotations !== undefined) set[side].rotations = ((rotations % 6) + 6) % 6;
    const slot = setterPosition !== undefined ? this.setterSlot(side) : undefined;
    if (setterPosition !== undefined && slot !== undefined) {
      // Find n such that (setterPosition - 1 + n) mod 6 == slot.
      set[side].rotations = ((slot - (setterPosition - 1)) % 6 + 6) % 6;
    }
    if (serving !== undefined) set.serving = serving;
    this.current = set;
  }

  // MARK: - Derived views

  /**
   * Players on court by position, with the libero applied automatically: the libero replaces a partner (normally a
   * middle) in the back row, except when that partner is serving and liberos may not serve.
   */
  onCourt(side: Side): Map<CourtPosition, PlayerID> {
    const team = this.current[side];
    const out = new Map<CourtPosition, PlayerID>();
    const sheet = this.sheets[side];
    for (const pos of CourtPosition.allCases) {
      const id = TeamInSet.playerAt(team, pos);
      out.set(pos, id);
      // The libero rule follows the slot: a substitute for a middle is replaced like the middle.
      const starter = TeamInSet.starterOfSlotHeldBy(team, id) ?? id;
      const libero = sheet?.liberos[0];
      if (!sheet || libero === undefined || !CourtPosition.isBackRow(pos)
          || !(sheet.liberoPartners.has(id) || sheet.liberoPartners.has(starter))) continue;
      const partnerServes = pos === 1 && this.current.serving === side;
      if (partnerServes && !this.liberoMayServe) continue;
      out.set(pos, libero);
    }
    return out;
  }

  /** Rotation number named by the setter's position (R1 = setter in P1), or by sequence when no setter is known. */
  rotationNumber(side: Side): number {
    const team = this.current[side];
    const slot = this.setterSlot(side);
    if (slot !== undefined) {
      // player(at: pos) = lineup[(pos - 1 + n) mod 6], so the setter's slot s sits at pos = ((s - n) mod 6) + 1.
      // Using the slot keeps the numbering right after the setter has been substituted out.
      return ((slot - team.rotations) % 6 + 6) % 6 + 1;
    }
    // No setter known: count side-outs in the R1, R6, R5, ... direction.
    return (6 - team.rotations % 6) % 6 + 1;
  }

  /** The rotational slot of the team's setter in this set's lineup order ("S" in a 5-1, "S1" in a 4-2 or 6-2). */
  setterSlot(side: Side): number | undefined {
    return this.slotOfRole("S", side) ?? this.slotOfRole("S1", side);
  }

  /** The rotational slot of the player who started the set with `role`; substitutes keep the slot. Swift `slot(ofRole:side:)`. */
  slotOfRole(role: string, side: Side): number | undefined {
    const sheet = this.sheets[side];
    if (!sheet) return undefined;
    const id = keyOf(sheet.roles, role);
    if (id === undefined) return undefined;
    const i = this.current[side].lineup.indexOf(id);
    if (i >= 0) return i;
    const j = sheet.startingLineup.indexOf(id);
    return j >= 0 ? j : undefined;
  }

  /** Court positions currently held by the rotational slots of the given roles. Swift `positions(ofRoles:side:)`. */
  positionsOfRoles(roles: readonly string[], side: Side): CourtPosition[] {
    const n = this.current[side].rotations;
    const out: CourtPosition[] = [];
    for (const role of roles) {
      const slot = this.slotOfRole(role, side);
      if (slot === undefined) continue;
      const pos = CourtPosition.fromRawValue(((slot - n) % 6 + 6) % 6 + 1);
      if (pos !== undefined) out.push(pos);
    }
    return out;
  }

  /**
   * The team's starting lineup rotated so that the next set starts in `rotation` (named by the setter's position; by
   * side-out sequence when no setter is known). Swift `lineup(_:startingIn:)`.
   */
  lineupStartingIn(side: Side, rotation: number): PlayerID[] | undefined {
    const sheet = this.sheets[side];
    const base = sheet?.startingLineup;
    if (!sheet || !base || !Number.isInteger(rotation) || rotation < 1 || rotation > 6) return undefined;
    const setter = keyOf(sheet.roles, "S") ?? keyOf(sheet.roles, "S1");
    const s = setter === undefined ? -1 : base.indexOf(setter);
    let k: number;
    if (s >= 0) {
      k = ((s - (rotation - 1)) % 6 + 6) % 6;   // player(at: P_rotation) is then the setter
    } else {
      k = (7 - rotation) % 6;                    // inverse of the sequence numbering above
    }
    return [0, 1, 2, 3, 4, 5].map((i) => base[(i + k) % 6]);
  }

  /** The server and the next servers of a team, in order. */
  servingOrder(side: Side, count = 3): PlayerID[] {
    const team = TeamInSet.clone(this.current[side]);
    const out: PlayerID[] = [];
    if (this.current.serving !== side) team.rotations += 1;   // the team must win a side-out first
    for (let i = 0; i < count; i++) {
      out.push(TeamInSet.playerAt(team, 1));
      team.rotations += 1;
    }
    return out;
  }

  // MARK: - Codable

  /** Swift's JSON shape; `sheets` is a [Side: TeamSheet] dictionary, encoded as a flat [side, sheet, ...] array. */
  static encode(m: MatchState): JsonValue {
    const sheets: [Side, TeamSheet][] = [];
    for (const side of Side.allCases) {
      const sheet = m.sheets[side];
      if (sheet) sheets.push([side, sheet]);
    }
    return {
      scoring: Scoring.encode(m.scoring),
      maxSubstitutionsPerSet: m.maxSubstitutionsPerSet,
      liberoMayServe: m.liberoMayServe,
      sheets: encodeFlatDictionary(sheets, (k) => k, TeamSheet.encode),
      sets: m.sets.map(SetState.encode),
      setsWonHome: m.setsWonHome,
      setsWonOpponent: m.setsWonOpponent,
    };
  }

  static decode(json: unknown, what = "MatchState"): MatchState {
    const r = new JsonReader(json, what);
    const m = Object.create(MatchState.prototype) as MatchState;
    m.scoring = r.req("scoring", Scoring.decode);
    m.maxSubstitutionsPerSet = r.int("maxSubstitutionsPerSet");
    m.liberoMayServe = r.bool("liberoMayServe");
    m.sheets = {};
    for (const [side, sheet] of r.req("sheets", (j, w) => decodeFlatDictionary(j, w, Side.decode, TeamSheet.decode))) {
      m.sheets[side] = sheet;
    }
    m.sets = r.array("sets", SetState.decode);
    m.setsWonHome = r.int("setsWonHome");
    m.setsWonOpponent = r.int("setsWonOpponent");
    return m;
  }
}
