// Port of MicroScoutTests (MatchAndScoutTests.swift).
import { describe, expect, it } from "vitest";
import type { CourtPosition } from "./court";
import { AttackLane, GridCell, MicroScout, ScoutLine, ScoutSummary } from "./microScout";

describe("MicroScoutTests", () => {
  const ctx = MicroScout.context({
    setNumber: 1, score: { home: 0, opponent: 0 }, homeRotation: 1, opponentRotation: 2,
    opponentFrontRowRoles: new Map<CourtPosition, string>([[4, "OH2"], [3, "MB2"], [2, "S"]]),
    opponentBackRowRoles: new Map<CourtPosition, string>([[5, "OH1"], [6, "OPP"], [1, "L"]]),
  });

  it("two taps commit a line", () => {
    const s = new MicroScout();
    expect(s.tap("opponent", { l: 1.0, d: 1.0 }, 10, ctx)).toEqual({ kind: "originAccepted", point: { l: 1.0, d: 1.0 } });
    const result = s.tap("home", { l: 1.5, d: 7.5 }, 11.5, ctx);
    if (result.kind !== "committed") throw new Error("expected a committed line");
    const line = result.line;
    expect(line.originLane).toBe("front4");
    expect(line.landingCell).toEqual({ zone: 5, sub: "c" });
    expect(line.outcome).toBe("inCourt");
    expect(line.depth).toBe("deep");
    expect(line.attacker?.role).toBe("OH2");
    expect(s.state).toEqual({ kind: "idle" });
  });

  it("origin expires after four seconds", () => {
    const s = new MicroScout();
    s.tap("opponent", { l: 4.5, d: 1.0 }, 0, ctx);
    expect(s.tap("home", { l: 4.5, d: 5.0 }, 4.5, ctx)).toEqual({ kind: "expired" });
    expect(s.tap("home", { l: 4.5, d: 5.0 }, 5.0, ctx)).toEqual({ kind: "rejected" });
  });

  it("direction classification", () => {
    // Opponent left-front (their l = 1) attacks straight down their left sideline:
    // in the world frame that is X = +3.5, landing on home's right side (home l = 8).
    const line = MicroScout.makeLine({ l: 1.0, d: 0.8 }, { l: 8.0, d: 7.5 }, 0, ctx, 1.0);
    expect(line.direction).toBe("line");
    const cross = MicroScout.makeLine({ l: 1.0, d: 0.8 }, { l: 1.5, d: 7.5 }, 0, ctx, 1.0);
    expect(cross.direction).toBe("cross");
    const cut = MicroScout.makeLine({ l: 1.0, d: 0.8 }, { l: 1.0, d: 3.0 }, 0, ctx, 1.0);
    expect(cut.direction).toBe("cut");
    const out = MicroScout.makeLine({ l: 1.0, d: 0.8 }, { l: 9.6, d: 5.0 }, 0, ctx, 1.0);
    expect(out.outcome).toBe("out");
  });

  it("lanes, grid cells, summary and the Codable shape (web)", () => {
    expect(AttackLane.classify({ l: 4.5, d: 5.0 })).toBe("pipe");
    expect(AttackLane.classify({ l: 7.0, d: 2.0 })).toBe("front2");
    expect(GridCell.locate({ l: 8.9, d: 0.2 })).toEqual({ zone: 2, sub: "b" });
    expect(GridCell.locate({ l: 9.1, d: 0.2 })).toBeUndefined();

    const s = new MicroScout();
    s.tap("opponent", { l: 1.0, d: 1.0 }, 10, ctx);
    const decoded = MicroScout.decode(JSON.parse(JSON.stringify(MicroScout.encode(s))));
    expect(MicroScout.encode(s)).toEqual({ timeout: 4, shortZoneDepth: 1,
                                           state: { originSet: { _0: { l: 1, d: 1 }, _1: 10 } } });
    expect(decoded.state).toEqual(s.state);

    const lines = [MicroScout.makeLine({ l: 1.0, d: 0.8 }, { l: 8.0, d: 7.5 }, 0, ctx, 1.0),
                   MicroScout.makeLine({ l: 1.0, d: 0.8 }, { l: 1.5, d: 7.5 }, 0, ctx, 1.0),
                   MicroScout.makeLine({ l: 1.0, d: 0.8 }, { l: 1.0, d: 3.0 }, 0, ctx, 1.0)];
    const summary = new ScoutSummary(lines);
    const key = { opponentRotation: 2, lane: "front4" as const };
    expect(summary.totalFor(key)).toBe(3);
    expect(summary.deepFor(key)).toBe(2);
    expect(summary.directions(key)).toEqual({ line: 1, cross: 1, cut: 1 });
    for (const line of lines) expect(ScoutLine.decode(JSON.parse(JSON.stringify(ScoutLine.encode(line))))).toEqual(line);
  });
});
