import "fake-indexeddb/auto";
import { LiveEvent, TeamSystem } from "../../core/match";
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
});
