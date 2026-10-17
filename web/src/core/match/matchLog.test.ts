// Port of NextSetAndStatsTests (SystemsAndLogTests.swift).
import { describe, expect, it } from "vitest";
import type { Side } from "./court";
import { JournalPayload, type JournalRecord, JournalRecordType, NotePayload } from "./journal";
import { LiveEvent, LiveState } from "./liveStore";
import { InkStroke } from "./liveTypes";
import { MatchLog, RallyRecord, RotationStats } from "./matchLog";
import { MatchState, TeamInSet, newPlayerID } from "./matchState";
import { TemplateLibrary } from "./rotationTemplate";
import { RuleCourtProfile } from "./ruleCourtProfile";
import { TestTeam, matchStartedRecord, run } from "./testSupport";

function makeState(firstServer: Side = "opponent"): [LiveState, TestTeam, TestTeam] {
  const home = new TestTeam();
  const away = new TestTeam();
  const state = new LiveState({
    setup: { profileName: "FIVB senior indoor", home: home.sheet, opponent: away.sheet, firstServer, mode: "solo",
             templateID: "5-1-outside-follows-setter" },
    profile: RuleCourtProfile.fivbSenior(),
    template: TemplateLibrary.shipped("5-1-outside-follows-setter"),
  });
  return [state, home, away];
}

describe("NextSetAndStatsTests", () => {
  it("lineup for every starting rotation", () => {
    const home = new TestTeam();
    const away = new TestTeam();
    const m = new MatchState({ profile: RuleCourtProfile.fivbSenior(), home: home.sheet, opponent: away.sheet, firstServer: "home" });
    for (let r = 1; r <= 6; r++) {
      const lineup = m.lineupStartingIn("home", r);
      expect(lineup).toBeDefined();
      expect(lineup![r - 1], `setter starts in P${r}`).toBe(home.s);
      // Rotational order is kept: the player after the setter is still OH1.
      expect(lineup![r % 6]).toBe(home.oh1);
    }
  });

  it("rally history and side-out records", () => {
    const [s] = makeState("opponent");
    for (const w of ["home", "home", "opponent", "opponent", "home"] as Side[]) s.reduce(LiveEvent.pointSwipe(w));
    expect(s.rallies.length).toBe(5);
    expect(RallyRecord.sideOut(s.rallies[0])).toBe(true);
    expect(RallyRecord.sideOut(s.rallies[1])).toBe(false);
    expect(s.rallies[2].scoreBefore).toEqual({ home: 2, opponent: 0 });
    expect(s.rallies[0].homeRotation).toBe(1);
    expect(s.rallies[1].homeRotation).toBe(6);
    const records = RotationStats.records(s.rallies, "home", 1);
    expect(records[0].receiveWon).toBe(1);        // R1
    expect(records[5].receiveWon).toBe(1);        // R6
    expect(records[5].receiveLost).toBe(1);
    expect(records[5].serveWon).toBe(1);
    expect(records[5].serveLost).toBe(1);
    expect(RotationStats.suggestedStart(records)?.rotation).toBe(1);
    s.reduce(LiveEvent.undo);
    expect(s.rallies.length).toBe(4);
  });

  it("next set starts in the chosen rotation and replays", () => {
    const [s, home] = makeState("home");
    const records: JournalRecord[] = [matchStartedRecord(s)];
    for (let i = 0; i < 25; i++) run(s, records, LiveEvent.pointSwipe("home"));
    expect(s.context).toEqual({ kind: "setBreak" });
    run(s, records, LiveEvent.startNextSet("opponent", 4));
    expect(s.match.current.number).toBe(2);
    expect(s.match.rotationNumber("home")).toBe(4);
    expect(TeamInSet.playerAt(s.match.current.home, 4)).toBe(home.s);
    const replayed = LiveState.replay(records, s.profile);
    expect(replayed).toBeDefined();
    expect(replayed!.match).toEqual(s.match);
    expect(replayed!.rallies).toEqual(s.rallies);
  });

  it("rewound shows the state before a rally", () => {
    const [s] = makeState();
    for (const w of ["home", "opponent", "opponent"] as Side[]) s.reduce(LiveEvent.pointSwipe(w));
    const third = s.rallies[2];
    const before = s.rewound(third.seq);
    expect(before.match.current.score).toEqual(third.scoreBefore);
    expect(before.match.current.serving).toBe(third.serving);
    expect(before.rallies.length).toBe(2);
    expect(s.match.current.score).toEqual({ home: 1, opponent: 2 });     // the original is untouched
  });

  it("match log attaches events to their rally", () => {
    const [s, , away] = makeState();
    const records: JournalRecord[] = [matchStartedRecord(s)];
    run(s, records, LiveEvent.pointSwipe("home"));
    run(s, records, LiveEvent.scoutTap("opponent", { l: 1, d: 1 }, 1));
    run(s, records, LiveEvent.scoutTap("home", { l: 2, d: 7 }, 2));
    run(s, records, LiveEvent.panicPressed(3));
    run(s, records, LiveEvent.ink(InkStroke.make([{ x: 0, z: 1 }, { x: 1, z: 2 }])));
    run(s, records, LiveEvent.panicDone);
    run(s, records, LiveEvent.substitution("opponent", away.oh1, newPlayerID(), { number: 4 }));
    run(s, records, LiveEvent.pointSwipe("opponent"));
    const second = s.rallies[1];
    records.push({ type: JournalRecordType.note, origin: 0, seq: s.nextSeq, lamport: s.nextSeq, wallClock: 0,
                   payload: JournalPayload.encode(NotePayload, { afterSeq: second.seq, text: "late block" }) });
    const rows = MatchLog.rows(s, records);
    expect(rows.length).toBe(2);
    expect(rows[0].scoutLines).toBe(0);
    expect(rows[1].scoutLines).toBe(1);
    expect(rows[1].sketchStrokes).toBe(1);
    expect(rows[1].timeOuts).toBe(1);
    expect(rows[1].substitutions).toBe(1);
    // The panic time-out is ours; then their substitution (web).
    expect(rows[0].interruptions).toEqual([]);
    expect(rows[1].interruptions).toEqual([{ kind: "timeOut", side: "home" }, { kind: "substitution", side: "opponent" }]);
    expect(rows[1].notes).toEqual(["late block"]);
    expect(RallyRecord.scoreAfter(rows[1].rally)).toEqual({ home: 1, opponent: 1 });
  });
});
