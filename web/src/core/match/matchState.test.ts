// Port of MatchStateTests (MatchAndScoutTests.swift).
import { describe, expect, it } from "vitest";
import type { Side } from "./court";
import { MatchState, TeamInSet, newPlayerID } from "./matchState";
import { RuleCourtProfile, Scoring } from "./ruleCourtProfile";
import { TestTeam, expectMatchError } from "./testSupport";

function makeMatch(firstServer: Side = "home"): [MatchState, TestTeam, TestTeam] {
  const home = new TestTeam();
  const away = new TestTeam();
  const m = new MatchState({ profile: RuleCourtProfile.fivbSenior(), home: home.sheet, opponent: away.sheet, firstServer });
  return [m, home, away];
}

describe("MatchStateTests", () => {
  it("side-out rotates only the team that wins serve", () => {
    const [m, home] = makeMatch("home");
    expect(m.rotationNumber("home")).toBe(1);
    const first = m.applyRally("home");               // server wins: no rotation
    expect(first.sideOut).toBe(false);
    expect(m.current.home.rotations).toBe(0);
    const second = m.applyRally("opponent");          // side-out for the opponent
    expect(second.sideOut).toBe(true);
    expect(m.current.serving).toBe("opponent");
    expect(m.current.opponent.rotations).toBe(1);
    expect(m.current.home.rotations).toBe(0);
    m.applyRally("home");                             // side-out back: home rotates, setter P1 -> P6
    expect(m.rotationNumber("home")).toBe(6);
    expect(TeamInSet.playerAt(m.current.home, 1), "the player from P2 now serves").toBe(home.oh1);
    expect(m.current.score).toEqual({ home: 2, opponent: 1 });
  });

  it("rotation sequence follows side-out order", () => {
    const [m] = makeMatch("opponent");
    const seen = [m.rotationNumber("home")];
    for (let i = 0; i < 6; i++) {
      m.applyRally("home");        // side-out for home
      seen.push(m.rotationNumber("home"));
      m.applyRally("opponent");    // side-out for opponent
    }
    expect(seen).toEqual([1, 6, 5, 4, 3, 2, 1]);
  });

  it("set ends at 25 with a two point lead and the deciding set at 15", () => {
    const [m] = makeMatch();
    for (let i = 0; i < 24; i++) m.applyRally("home");
    for (let i = 0; i < 24; i++) m.applyRally("opponent");
    expect(m.current.winner, "24:24 is not over").toBeUndefined();
    m.applyRally("home");
    expect(m.current.winner, "25:24 is not over").toBeUndefined();
    const out = m.applyRally("home");
    expect(out.setEnded).toBe(true);
    expect(m.current.winner).toBe("home");
    expect(() => m.applyRally("home")).toThrow();
    // Play to a deciding fifth set.
    for (let set = 2; set <= 4; set++) {
      m.startNextSet();
      expect(m.current.number).toBe(set);
      const winner: Side = set % 2 === 0 ? "opponent" : (set === 3 ? "home" : "opponent");
      while (m.current.winner === undefined) m.applyRally(winner);
    }
    expect(m.setsWonHome).toBe(2);
    expect(m.setsWonOpponent).toBe(2);
    m.startNextSet({ firstServer: "home" });
    expect(Scoring.targetPoints(m.scoring, m.current.number)).toBe(15);
    while (m.current.winner === undefined) m.applyRally("home");
    expect(m.current.score.home).toBe(15);
    expect(m.isOver).toBe(true);
  });

  it("first server alternates between sets", () => {
    const [m] = makeMatch("home");
    while (m.current.winner === undefined) m.applyRally("home");
    m.startNextSet();
    expect(m.current.serving).toBe("opponent");
  });

  it("libero replaces the back-row middle except when the middle serves", () => {
    const [m, home] = makeMatch("opponent");
    // R1 receiving: MB2 is at P6 (back row) -> libero in.
    expect(m.onCourt("home").get(6)).toBe(home.libero);
    // Move home to R5: MB1 reaches P1. While home serves, MB1 must serve (liberos may not serve).
    m.applyRally("home");          // R6, home serves; MB2 now P5 -> still libero
    expect(m.onCourt("home").get(5)).toBe(home.libero);
    m.applyRally("opponent");
    m.applyRally("home");          // R5, home serves, MB1 at P1
    expect(m.rotationNumber("home")).toBe(5);
    expect(m.onCourt("home").get(1), "the middle serves").toBe(home.mb1);
    m.applyRally("opponent");      // home loses serve: libero takes P1 for defence
    expect(m.onCourt("home").get(1)).toBe(home.libero);
  });

  it("substitution pairing and limit", () => {
    const [m, home] = makeMatch();
    const b1 = newPlayerID();
    const b2 = newPlayerID();
    const b3 = newPlayerID();
    m.substitute("home", home.oh2, b1);
    // A substitute may only leave for the starter it replaced.
    expectMatchError(() => m.substitute("home", b1, b2), "illegalSubstitution");
    m.substitute("home", b1, home.oh2);
    // The pair is complete: the starter cannot leave again in this set.
    expectMatchError(() => m.substitute("home", home.oh2, b2), "illegalSubstitution");
    m.substitute("home", home.oh1, b2);
    m.substitute("home", b2, home.oh1);
    m.substitute("home", home.opp, b3);
    m.substitute("home", b3, home.opp);
    expectMatchError(() => m.substitute("home", home.s, newPlayerID()), "substitutionLimitReached");
  });

  it("libero and role follow the slot after a substitution", () => {
    const [m, home] = makeMatch("opponent");
    const sub = newPlayerID();
    // MB2 starts in P6 (back row): the libero is in for MB2.
    expect(m.onCourt("home").get(6)).toBe(home.libero);
    m.substitute("home", home.mb2, sub);
    expect(m.onCourt("home").get(6)).toBe(home.libero);      // the libero now replaces the substitute
    expect(m.displayRole(sub, "home")).toBe("MB2");
    expect(m.bench("home", [sub])).toContain(home.mb2);
    expect(m.bench("home", [sub])).not.toContain(sub);
  });

  it("set point and match point", () => {
    const [m] = makeMatch("home");
    for (let i = 0; i < 24; i++) m.applyRally("home");
    expect(m.pointStatus("home")).toBe("setPoint");
    expect(m.pointStatus("opponent")).toBeUndefined();
    m.applyRally("home");
    m.startNextSet();
    for (let i = 0; i < 25; i++) m.applyRally("home");
    m.startNextSet();
    for (let i = 0; i < 24; i++) m.applyRally("home");
    expect(m.pointStatus("home")).toBe("matchPoint");
  });

  it("rotation correction by setter position", () => {
    const [m] = makeMatch();
    m.correctRotation("home", { setterPosition: 4, rotations: undefined, serving: "opponent" });
    expect(m.rotationNumber("home")).toBe(4);
    expect(m.current.serving).toBe("opponent");
  });

  it("clone is independent and encode/decode round-trips (web)", () => {
    const [m, home] = makeMatch("opponent");
    m.applyRally("home");
    m.substitute("home", home.oh2, newPlayerID());
    const copy = m.clone();
    copy.applyRally("home");
    expect(m.current.score).toEqual({ home: 1, opponent: 0 });
    expect(copy.current.score).toEqual({ home: 2, opponent: 0 });
    const decoded = MatchState.decode(JSON.parse(JSON.stringify(MatchState.encode(m))));
    expect(decoded).toBeInstanceOf(MatchState);
    expect(decoded).toEqual(m);
    expect(decoded.rotationNumber("home")).toBe(m.rotationNumber("home"));
  });
});
