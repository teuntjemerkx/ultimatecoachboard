// TEMP STAND-IN: replaced by the match port
// Minimal port of Court/CourtGeometry.swift so spatial/ and zones/ compile and test before the match port lands.

/** The two teams on the court. */
export type Side = "home" | "opponent";

export const Side = {
  allCases: ["home", "opponent"] as readonly Side[],
  other(side: Side): Side {
    return side === "home" ? "opponent" : "home";
  },
};

/** A point in a team's own frame: `l` from that team's left sideline facing the net, `d` from the centre line (m). */
export interface LocalPoint {
  l: number;
  d: number;
}

/** A floor point in the world frame: X along the net (+X home's right), Z across it (home half Z > 0), metres. */
export interface FloorPoint {
  x: number;
  z: number;
}

/** Conversions between the world frame and the team-local frames. */
export const CourtFrame = {
  halfWidth: 4.5,

  local(p: FloorPoint, side: Side): LocalPoint {
    return side === "home" ? { l: p.x + 4.5, d: p.z } : { l: 4.5 - p.x, d: -p.z };
  },

  world(p: LocalPoint, side: Side): FloorPoint {
    return side === "home" ? { x: p.l - 4.5, z: p.d } : { x: 4.5 - p.l, z: -p.d };
  },

  /** Which half a world point lies on (the net plane is reported as home). */
  side(p: FloorPoint): Side {
    return p.z >= 0 ? "home" : "opponent";
  },
};

/** Rotational positions 1...6 (P1 right back, the server ... P6 middle back). */
export type CourtPosition = 1 | 2 | 3 | 4 | 5 | 6;

export const CourtPosition = {
  allCases: [1, 2, 3, 4, 5, 6] as readonly CourtPosition[],
  isFrontRow(p: CourtPosition): boolean {
    return p === 2 || p === 3 || p === 4;
  },
  isBackRow(p: CourtPosition): boolean {
    return !(p === 2 || p === 3 || p === 4);
  },
  label(p: CourtPosition): string {
    return `P${p}`;
  },
  fromRawValue(n: number): CourtPosition | undefined {
    return Number.isInteger(n) && n >= 1 && n <= 6 ? (n as CourtPosition) : undefined;
  },
};
