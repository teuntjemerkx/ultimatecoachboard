import "fake-indexeddb/auto";
import { CourtPosition, LiveEvent, TeamInSet, TeamSystem, newPlayerID } from "../../core/match";
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

  it("subs players new to the match for both teams, with their numbers through reopening and undo", async () => {
    const bench = [{ id: crypto.randomUUID().toUpperCase(), number: 15, name: "Bench 15" }];
    const s = await MatchSession.start({ ...setup, bench });
    const at = (pos: CourtPosition) => TeamInSet.playerAt(s.state.match.current.opponent, pos);
    const [their7, their3] = [at(3), at(1)];
    expect(s.number(their7)).toBe(7);
    // Their #22 for their #7; then our #31, not in the team, for #9.
    const their22 = newPlayerID(), our31 = newPlayerID();
    s.dispatch(LiveEvent.substitution("opponent", their7, their22, { number: 22 }));
    s.dispatch(LiveEvent.pointSwipe("home"));
    s.dispatch(LiveEvent.substitution("home", players[3].id, our31, { number: 31 }));
    expect([s.who(their22), s.label(their22, "MB"), s.who(our31)]).toEqual(["#22", "22", "#31"]);
    expect(s.state.bench("opponent")).toEqual([their7]);
    // Only their #7 can come back for #22; their #3 is on court, and a number typed for them finds them.
    expect(s.state.playerWithNumber("opponent", 3)).toBe(their3);
    expect(s.state.playerWithNumber("home", 8)).toBe(players[0].id);
    expect(s.state.substitutionRefusal("opponent", their22, their3)).toMatchObject({ reason: "alreadyOnCourt" });
    expect(s.state.substitutionRefusal("opponent", their22, newPlayerID())).toMatchObject({ reason: "onlyPartner", partner: their7 });
    await s.flush();

    const again = (await MatchSession.open(s.id))!;
    expect(again.state.match).toEqual(s.state.match);
    expect(again.state.log).toEqual(s.state.log);
    expect([again.who(their22), again.who(our31), again.number(their7)]).toEqual(["#22", "#31", 7]);
    // Our #31 goes off again for #9 and waits on our bench after the team's players.
    again.dispatch(LiveEvent.substitution("home", our31, players[3].id));
    expect(again.state.bench("home")).toEqual([bench[0].id, our31]);
    expect(again.who(our31)).toBe("#31");
    // Undo: #9 back off, our #31 gone again with their number; then the point, and their #22 is gone too.
    again.dispatch(LiveEvent.undo);
    again.dispatch(LiveEvent.undo);
    expect(again.number(our31)).toBeUndefined();
    expect(again.state.bench("home")).toEqual([bench[0].id]);
    again.dispatch(LiveEvent.undo);
    again.dispatch(LiveEvent.undo);
    expect(again.number(their22)).toBeUndefined();
    expect(again.state.match.current.opponent.lineup).toContain(their7);
    await again.flush();
    const third = (await MatchSession.open(s.id))!;
    expect(third.state.newcomers.size).toBe(0);
    expect(third.state.match).toEqual(again.state.match);
  });

  it("names their player by role when no number is known", async () => {
    const s = await MatchSession.start({ ...setup, opponentNumbers: [null, null, null, null, null, null] });
    const id = TeamInSet.playerAt(s.state.match.current.opponent, 1);
    expect(s.who(id)).toBe(s.state.match.displayRole(id, "opponent"));
    expect(s.who(id)).not.toBe("a player");
  });
});
