import "fake-indexeddb/auto";
import { CourtPosition, LiveEvent, TeamInSet, TeamSystem } from "../../core/match";
import { MatchSession, type MatchSetup } from "./session";

const players = [8, 12, 4, 9, 14, 2].map((n) => ({ id: crypto.randomUUID().toUpperCase(), number: n }));
const setup: MatchSetup = {
  homeName: "Orion", opponentName: "Dynamo", system: TeamSystem.fiveOneOutside, slots: players,
  libero: { id: crypto.randomUUID().toUpperCase(), number: 6 }, bench: [], setterPosition: 1,
  opponentNumbers: [3, 11, 7, 10, 5, 1], opponentSetterPosition: 1, firstServer: "opponent", netHeight: 2.24, mode: "solo",
};

describe("a match on the device", () => {
  it("keeps every point and opens again where it was left", async () => {
    const s = await MatchSession.start(setup);
    for (const w of ["home", "home", "opponent", "home"] as const) s.dispatch(LiveEvent.pointSwipe(w));
    expect(s.state.match.current.score).toEqual({ home: 3, opponent: 1 });
    // Two side-outs for the home team (rallies 1 and 4): rotation 1, then 6, then 5.
    expect(s.state.match.rotationNumber("home")).toBe(5);
    const again = await MatchSession.open(s.id);
    expect(again?.state.match.current.score).toEqual({ home: 3, opponent: 1 });
    expect(again?.label(players[0].id, "S")).toBe("8");
    again!.dispatch(LiveEvent.undo);
    expect(again!.state.match.current.score).toEqual({ home: 2, opponent: 1 });
  });

  it("plays a whole set to 25 and starts the next", async () => {
    const s = await MatchSession.start(setup);
    for (let i = 0; i < 25; i++) s.dispatch(LiveEvent.pointSwipe("home"));
    expect(s.state.match.current.winner).toBe("home");
    s.dispatch(LiveEvent.startNextSet());
    expect(s.state.match.current.number).toBe(2);
    expect(s.state.match.setsWon("home")).toBe(1);
  });

  it("keeps substitutions and time-outs through undo and reopening", async () => {
    const bench = [15, 17].map((n) => ({ id: crypto.randomUUID().toUpperCase(), number: n, name: `Bench ${n}` }));
    const s = await MatchSession.start({ ...setup, bench });
    const [p4, sub] = [players[3].id, bench[0].id];
    expect(s.state.homeBench).toEqual(bench.map((b) => b.id));
    s.dispatch(LiveEvent.substitution("home", p4, sub));
    s.dispatch(LiveEvent.timeOut("home"));
    s.dispatch(LiveEvent.pointSwipe("opponent"));
    s.dispatch(LiveEvent.timeOut("opponent"));
    s.dispatch(LiveEvent.timeOut("home"));
    s.dispatch(LiveEvent.timeOut("home"));          // a third one is refused
    expect(s.state.match.timeOutsLeft("home")).toBe(0);
    expect(s.state.match.substitutionsLeft("home")).toBe(5);
    // Only the starter may come back for the substitute; the refusal says so.
    expect(s.state.substitutionRefusal("home", sub, bench[1].id)).toMatchObject({ reason: "onlyPartner", partner: p4 });
    expect(s.who(sub)).toBe("#15 Bench 15");
    s.dispatch(LiveEvent.undo);                     // takes back the home team's second time-out
    await s.flush();

    const again = (await MatchSession.open(s.id))!;
    expect(again.state.match).toEqual(s.state.match);
    expect(again.state.log).toEqual(s.state.log);
    expect(again.state.match.timeOutsLeft("home")).toBe(1);
    expect(again.state.match.timeOutsLeft("opponent")).toBe(1);
    expect(again.state.match.current.home.lineup).toContain(sub);
    expect(again.state.lastAction?.action).toEqual({ kind: "timeOut", side: "opponent" });
    // Undo goes on where it left off: their time-out, the point, our time-out, then the substitution.
    for (let i = 0; i < 4; i++) again.dispatch(LiveEvent.undo);
    expect(again.state.match.current.home.lineup).toContain(p4);
    expect(again.state.match.substitutionsLeft("home")).toBe(6);
    expect(again.state.match.timeOutsLeft("home")).toBe(2);
    expect(again.state.match.current.score).toEqual({ home: 0, opponent: 0 });
  });

  it("puts their numbers and setter on court", async () => {
    const s = await MatchSession.start({ ...setup, opponentNumbers: [3, 11, null, 10, 5, 1], opponentSetterPosition: 4 });
    const m = s.state.match;
    const at = (pos: CourtPosition) => TeamInSet.playerAt(m.current.opponent, pos);
    expect([1, 2, 4, 5, 6].map((p) => s.number(at(p as CourtPosition)))).toEqual([3, 11, 10, 5, 1]);
    expect(s.number(at(3))).toBeUndefined();          // left empty: no number, the role shows instead
    expect(m.rotationNumber("opponent")).toBe(4);     // their setter starts in position 4
  });
});
