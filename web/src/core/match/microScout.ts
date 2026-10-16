// Port of Scouting/MicroScout.swift: the two-tap attack scouting state machine and its summary.
import { type JsonValue, JsonReader, compact, decodeRaw, decodeTagged, encodeTagged, DecodingError } from "./codable";
import { CourtFrame, type CourtPosition, LocalPoint, type Side } from "./court";
import { Score } from "./matchState";

const lanes = ["front4", "front3", "front2", "backLeft", "pipe", "backRight"] as const;

/**
 * Where an opponent attack started (blueprint Section 2.9): front4, front3, front2 are the front row by lateral
 * thirds of the opponent's frame; backLeft, pipe, backRight are behind the 3.5 m depth (back-row attacks, pipe, D).
 */
export type AttackLane = (typeof lanes)[number];

export const AttackLane = {
  allCases: lanes as readonly AttackLane[],

  classify(origin: LocalPoint): AttackLane {
    const third = origin.l < 3 ? 0 : (origin.l < 6 ? 1 : 2);
    if (origin.d <= 3.5) return (["front4", "front3", "front2"] as const)[third];
    return (["backLeft", "pipe", "backRight"] as const)[third];
  },

  decode(json: unknown, what = "AttackLane"): AttackLane {
    return decodeRaw(json, what, AttackLane.allCases);
  },
};

/**
 * A landing cell: one of nine 3 x 3 m zones split into four 1.5 m sub-cells.
 * Zone numbers: 4, 3, 2 near the net (left to right), 7, 8, 9 in the middle, 5, 6, 1 at the back.
 * Sub-cells are the app's own convention: a = net-left, b = net-right, c = back-right, d = back-left.
 */
export interface GridCell {
  zone: number;
  sub: string;
}

export const GridCell = {
  locate(p: LocalPoint): GridCell | undefined {
    if (!(p.l >= 0 && p.l <= 9 && p.d >= 0 && p.d <= 9)) return undefined;
    const col = Math.min(Math.trunc(p.l / 3), 2);
    const row = Math.min(Math.trunc(p.d / 3), 2);
    const zones = [[4, 3, 2], [7, 8, 9], [5, 6, 1]];
    const inL = p.l - col * 3;
    const inD = p.d - row * 3;
    const netSide = inD < 1.5;
    const leftSide = inL < 1.5;
    const sub = netSide ? (leftSide ? "a" : "b") : (leftSide ? "d" : "c");
    return { zone: zones[row][col], sub };
  },

  encode(c: GridCell): JsonValue {
    return { zone: c.zone, sub: c.sub };
  },

  decode(json: unknown, what = "GridCell"): GridCell {
    const r = new JsonReader(json, what);
    return { zone: r.int("zone"), sub: r.str("sub") };
  },
};

export type LandingOutcome = "inCourt" | "out" | "short";
export type AttackDirection = "line" | "cross" | "cut";
export type AttackDepth = "short" | "mid" | "deep";

const outcomes: readonly LandingOutcome[] = ["inCourt", "out", "short"];
const directions: readonly AttackDirection[] = ["line", "cross", "cut"];
const depths: readonly AttackDepth[] = ["short", "mid", "deep"];

export interface AttributedAttacker {
  role: string;
  probability: number;
}

/** One logged attack line (blueprint Section 2.9, journal type 0x000A). */
export interface ScoutLine {
  time: number;
  setNumber: number;
  score: Score;
  homeRotation: number;
  opponentRotation: number;
  /** In the opponent's frame. */
  originRaw: LocalPoint;
  /** In the home frame. */
  landingRaw: LocalPoint;
  originLane: AttackLane;
  landingCell?: GridCell;
  outcome: LandingOutcome;
  direction: AttackDirection;
  depth: AttackDepth;
  attacker?: AttributedAttacker;
}

export const ScoutLine = {
  encode(s: ScoutLine): JsonValue {
    return compact({
      time: s.time, setNumber: s.setNumber, score: Score.encode(s.score), homeRotation: s.homeRotation,
      opponentRotation: s.opponentRotation, originRaw: LocalPoint.encode(s.originRaw),
      landingRaw: LocalPoint.encode(s.landingRaw), originLane: s.originLane,
      landingCell: s.landingCell && GridCell.encode(s.landingCell), outcome: s.outcome, direction: s.direction,
      depth: s.depth, attacker: s.attacker && { role: s.attacker.role, probability: s.attacker.probability },
    });
  },

  decode(json: unknown, what = "ScoutLine"): ScoutLine {
    const r = new JsonReader(json, what);
    return {
      time: r.num("time"), setNumber: r.int("setNumber"), score: r.req("score", Score.decode),
      homeRotation: r.int("homeRotation"), opponentRotation: r.int("opponentRotation"),
      originRaw: r.req("originRaw", LocalPoint.decode), landingRaw: r.req("landingRaw", LocalPoint.decode),
      originLane: r.req("originLane", AttackLane.decode), landingCell: r.opt("landingCell", GridCell.decode),
      outcome: r.raw("outcome", outcomes), direction: r.raw("direction", directions), depth: r.raw("depth", depths),
      attacker: r.opt("attacker", (j, w) => {
        const a = new JsonReader(j, w);
        return { role: a.str("role"), probability: a.num("probability") };
      }),
    };
  },
};

export type ScoutTapResult =
  | { kind: "originAccepted"; point: LocalPoint }
  | { kind: "originReplaced"; point: LocalPoint }
  | { kind: "committed"; line: ScoutLine }
  | { kind: "rejected" }
  | { kind: "expired" };

export declare namespace MicroScout {
  /** Swift `MicroScout.State`: `.idle` or `.originSet(LocalPoint, Double)`. */
  type State = { kind: "idle" } | { kind: "originSet"; origin: LocalPoint; time: number };

  /** Context needed to stamp and attribute a committed line. */
  interface Context {
    setNumber: number;
    score: Score;
    homeRotation: number;
    opponentRotation: number;
    opponentFrontRowRoles: ReadonlyMap<CourtPosition, string>;
    opponentBackRowRoles: ReadonlyMap<CourtPosition, string>;
  }
}

/**
 * The two-tap state machine. Taps arrive already converted to the team-local frame of the half that was hit.
 * A Swift value type: mutating methods change this instance; `clone()` copies it.
 */
export class MicroScout {
  timeout = 4.0;
  shortZoneDepth = 1.0;
  private _state: MicroScout.State = { kind: "idle" };

  get state(): MicroScout.State {
    return this._state;
  }

  clone(): MicroScout {
    const s = new MicroScout();
    s.timeout = this.timeout;
    s.shortZoneDepth = this.shortZoneDepth;
    s._state = this._state;   // states are never mutated in place
    return s;
  }

  /** Swift `Context(setNumber:score:homeRotation:opponentRotation:opponentFrontRowRoles:opponentBackRowRoles:)`. */
  static context({ setNumber, score, homeRotation, opponentRotation, opponentFrontRowRoles = new Map(),
                   opponentBackRowRoles = new Map() }: {
    setNumber: number; score: Score; homeRotation: number; opponentRotation: number;
    opponentFrontRowRoles?: ReadonlyMap<CourtPosition, string>; opponentBackRowRoles?: ReadonlyMap<CourtPosition, string>;
  }): MicroScout.Context {
    return { setNumber, score, homeRotation, opponentRotation, opponentFrontRowRoles, opponentBackRowRoles };
  }

  /** Expires a pending origin; returns true when an origin was dropped. */
  tick(now: number): boolean {
    if (this._state.kind === "originSet" && now - this._state.time > this.timeout) {
      this._state = { kind: "idle" };
      return true;
    }
    return false;
  }

  tap(side: Side, local: LocalPoint, now: number, context: MicroScout.Context): ScoutTapResult {
    const expired = this.tick(now);
    const state = this._state;
    if (side === "opponent") {
      this._state = { kind: "originSet", origin: local, time: now };
      return state.kind === "idle" ? { kind: "originAccepted", point: local } : { kind: "originReplaced", point: local };
    }
    if (state.kind === "originSet") {
      this._state = { kind: "idle" };
      return { kind: "committed",
               line: MicroScout.makeLine(state.origin, local, now, context, this.shortZoneDepth) };
    }
    return expired ? { kind: "expired" } : { kind: "rejected" };
  }

  cancel(): void {
    this._state = { kind: "idle" };
  }

  static makeLine(origin: LocalPoint, landing: LocalPoint, time: number, context: MicroScout.Context,
                  shortZoneDepth: number): ScoutLine {
    const lane = AttackLane.classify(origin);
    const inside = landing.l >= 0 && landing.l <= 9 && landing.d >= 0 && landing.d <= 9;
    const outcome: LandingOutcome = !inside ? "out" : (landing.d <= shortZoneDepth ? "short" : "inCourt");
    // Direction in the world frame: the attack vector from origin to landing.
    const o = CourtFrame.world(origin, "opponent");
    const t = CourtFrame.world(landing, "home");
    const dx = Math.abs(t.x - o.x);
    const dz = Math.abs(t.z - o.z);
    const angle = Math.atan2(dx, Math.max(dz, 1e-9)) * 180 / Math.PI;
    let direction: AttackDirection;
    if (landing.d < 4.5 && dx >= 4.0) {
      direction = "cut";
    } else if (angle < 15) {
      direction = "line";
    } else {
      direction = "cross";
    }
    const depth: AttackDepth = landing.d < 3 ? "short" : (landing.d > 6 ? "deep" : "mid");
    return { time, setNumber: context.setNumber, score: { ...context.score }, homeRotation: context.homeRotation,
             opponentRotation: context.opponentRotation, originRaw: origin, landingRaw: landing, originLane: lane,
             landingCell: GridCell.locate(landing), outcome, direction, depth,
             attacker: MicroScout.attribute(lane, context) };
  }

  /**
   * Lane-to-role prior: front lanes map to the front-row player at the matching position after switching (OH left,
   * MB middle, OPP or front setter right); back lanes to back-row attackers.
   */
  static attribute(lane: AttackLane, context: MicroScout.Context): AttributedAttacker | undefined {
    const role = (roles: ReadonlyMap<CourtPosition, string>, matching: (r: string) => boolean): string | undefined => {
      for (const r of roles.values()) if (matching(r)) return r;
      return undefined;
    };
    const front = context.opponentFrontRowRoles;
    const back = context.opponentBackRowRoles;
    let r: string | undefined;
    switch (lane) {
      case "front4":
        if ((r = role(front, (x) => x.startsWith("OH"))) !== undefined) return { role: r, probability: 0.8 };
        break;
      case "front3":
        if ((r = role(front, (x) => x.startsWith("MB"))) !== undefined) return { role: r, probability: 0.8 };
        break;
      case "front2":
        if ((r = role(front, (x) => x === "OPP" || x.startsWith("S"))) !== undefined) return { role: r, probability: 0.8 };
        break;
      case "pipe":
        if ((r = role(back, (x) => x.startsWith("OH"))) !== undefined) return { role: r, probability: 0.7 };
        break;
      case "backRight":
        if ((r = role(back, (x) => x === "OPP")) !== undefined) return { role: r, probability: 0.7 };
        break;
      case "backLeft":
        if ((r = role(back, (x) => x.startsWith("OH"))) !== undefined) return { role: r, probability: 0.5 };
        break;
    }
    return undefined;
  }

  /** Swift's JSON shape: {"timeout", "shortZoneDepth", "state": {"idle": {}} or {"originSet": {"_0": point, "_1": time}}}. */
  static encode(s: MicroScout): JsonValue {
    const state = s._state.kind === "idle"
      ? encodeTagged("idle")
      : encodeTagged("originSet", { _0: LocalPoint.encode(s._state.origin), _1: s._state.time });
    return { timeout: s.timeout, shortZoneDepth: s.shortZoneDepth, state };
  }

  static decode(json: unknown, what = "MicroScout"): MicroScout {
    const r = new JsonReader(json, what);
    const s = new MicroScout();
    s.timeout = r.num("timeout");
    s.shortZoneDepth = r.num("shortZoneDepth");
    s._state = r.req("state", (j, w) => {
      const [tag, p] = decodeTagged(j, w);
      switch (tag) {
        case "idle": return { kind: "idle" } as const;
        case "originSet": return { kind: "originSet", origin: p.req("_0", LocalPoint.decode), time: p.num("_1") } as const;
        default: throw new DecodingError(`${w}: unknown case ${tag}`);
      }
    });
    return s;
  }
}

export declare namespace ScoutSummary {
  interface Key {
    opponentRotation: number;
    lane: AttackLane;
  }
}

/**
 * Aggregation for Panic and Set Break: counts per opponent rotation and lane. The maps are keyed by
 * `ScoutSummary.keyString(key)` (Swift keys them by the `Key` struct).
 */
export class ScoutSummary {
  counts = new Map<string, Partial<Record<AttackDirection, number>>>();
  deep = new Map<string, number>();
  total = new Map<string, number>();

  static keyString(key: ScoutSummary.Key): string {
    return `${key.opponentRotation}|${key.lane}`;
  }

  constructor(lines: readonly ScoutLine[]) {
    for (const line of lines) {
      const key = ScoutSummary.keyString({ opponentRotation: line.opponentRotation, lane: line.originLane });
      const byDirection = this.counts.get(key) ?? {};
      byDirection[line.direction] = (byDirection[line.direction] ?? 0) + 1;
      this.counts.set(key, byDirection);
      this.total.set(key, (this.total.get(key) ?? 0) + 1);
      if (line.depth === "deep") this.deep.set(key, (this.deep.get(key) ?? 0) + 1);
    }
  }

  /** Lines per direction for an opponent rotation and lane. */
  directions(key: ScoutSummary.Key): Partial<Record<AttackDirection, number>> {
    return this.counts.get(ScoutSummary.keyString(key)) ?? {};
  }

  totalFor(key: ScoutSummary.Key): number {
    return this.total.get(ScoutSummary.keyString(key)) ?? 0;
  }

  deepFor(key: ScoutSummary.Key): number {
    return this.deep.get(ScoutSummary.keyString(key)) ?? 0;
  }
}
