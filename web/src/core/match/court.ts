// Port of Court/CourtGeometry.swift: sides, team-local and world floor points, rotational positions.
import { type JsonValue, JsonReader, decodeInt, decodeRaw, DecodingError } from "./codable";

/** The two teams on the court. */
export type Side = "home" | "opponent";

export const Side = {
  allCases: ["home", "opponent"] as readonly Side[],

  other(side: Side): Side {
    return side === "home" ? "opponent" : "home";
  },

  encode(side: Side): JsonValue {
    return side;
  },

  decode(json: unknown, what = "Side"): Side {
    return decodeRaw(json, what, Side.allCases);
  },
};

/**
 * A point in a team's own frame (blueprint Section 0.4): `l` is measured from that team's left sideline while
 * facing the net, `d` from the centre line, both in metres.
 */
export interface LocalPoint {
  l: number;
  d: number;
}

export const LocalPoint = {
  make(l: number, d: number): LocalPoint {
    return { l, d };
  },

  /** Swift `LocalPoint(_ pair:)`: exactly two coordinates. */
  fromPair(pair: readonly number[]): LocalPoint {
    if (pair.length !== 2) throw new Error("a LocalPoint needs exactly two coordinates");
    return { l: pair[0], d: pair[1] };
  },

  add(a: LocalPoint, b: LocalPoint): LocalPoint {
    return { l: a.l + b.l, d: a.d + b.d };
  },

  sub(a: LocalPoint, b: LocalPoint): LocalPoint {
    return { l: a.l - b.l, d: a.d - b.d };
  },

  distance(a: LocalPoint, b: LocalPoint): number {
    const dl = b.l - a.l;
    const dd = b.d - a.d;
    return Math.sqrt(dl * dl + dd * dd);
  },

  encode(p: LocalPoint): JsonValue {
    return { l: p.l, d: p.d };
  },

  decode(json: unknown, what = "LocalPoint"): LocalPoint {
    const r = new JsonReader(json, what);
    return { l: r.num("l"), d: r.num("d") };
  },
};

/**
 * A point on the floor in the world frame (blueprint Section 0.3): X along the net (+X is the home team's right),
 * Z perpendicular to the net (home half Z > 0, opponent half Z < 0), metres.
 */
export interface FloorPoint {
  x: number;
  z: number;
}

export const FloorPoint = {
  make(x: number, z: number): FloorPoint {
    return { x, z };
  },

  encode(p: FloorPoint): JsonValue {
    return { x: p.x, z: p.z };
  },

  decode(json: unknown, what = "FloorPoint"): FloorPoint {
    const r = new JsonReader(json, what);
    return { x: r.num("x"), z: r.num("z") };
  },
};

/** Conversions between the world frame and the team-local frames. */
export const CourtFrame = {
  halfWidth: 4.5,

  local(p: FloorPoint, side: Side): LocalPoint {
    return side === "home"
      ? { l: p.x + CourtFrame.halfWidth, d: p.z }
      : { l: CourtFrame.halfWidth - p.x, d: -p.z };
  },

  world(p: LocalPoint, side: Side): FloorPoint {
    return side === "home"
      ? { x: p.l - CourtFrame.halfWidth, z: p.d }
      : { x: CourtFrame.halfWidth - p.l, z: -p.d };
  },

  /** Which half of the court a world point lies on (the net plane belongs to neither; it is reported as home). */
  side(p: FloorPoint): Side {
    return p.z >= 0 ? "home" : "opponent";
  },
};

/** Rotational positions, numbered as in the rules: P1 right back (server) ... P6 middle back. Raw value = number. */
export type CourtPosition = 1 | 2 | 3 | 4 | 5 | 6;

const allPositions: readonly CourtPosition[] = [1, 2, 3, 4, 5, 6];

export const CourtPosition = {
  p1: 1 as CourtPosition,
  p2: 2 as CourtPosition,
  p3: 3 as CourtPosition,
  p4: 4 as CourtPosition,
  p5: 5 as CourtPosition,
  p6: 6 as CourtPosition,
  allCases: allPositions,

  /** Swift `CourtPosition(rawValue:)`. */
  fromRawValue(raw: number): CourtPosition | undefined {
    return allPositions.includes(raw as CourtPosition) ? (raw as CourtPosition) : undefined;
  },

  isFrontRow(p: CourtPosition): boolean {
    return p === 2 || p === 3 || p === 4;
  },

  isBackRow(p: CourtPosition): boolean {
    return !CourtPosition.isFrontRow(p);
  },

  label(p: CourtPosition): string {
    return `P${p}`;
  },

  /** Clockwise rotation on a side-out: P2 -> P1, P1 -> P6, P6 -> P5, P5 -> P4, P4 -> P3, P3 -> P2. */
  afterRotation(p: CourtPosition): CourtPosition {
    switch (p) {
      case 1: return 6;
      case 2: return 1;
      case 3: return 2;
      case 4: return 3;
      case 5: return 4;
      case 6: return 5;
    }
  },

  encode(p: CourtPosition): JsonValue {
    return p;
  },

  decode(json: unknown, what = "CourtPosition"): CourtPosition {
    const raw = decodeInt(json, what);
    const p = CourtPosition.fromRawValue(raw);
    if (p === undefined) throw new DecodingError(`${what}: ${raw} is not a court position`);
    return p;
  },
};
