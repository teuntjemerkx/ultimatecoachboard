// Port of LiveStateTests (GeometryJournalLiveTests.swift).
import { describe, expect, it } from "vitest";
import type { JournalRecord } from "./journal";
import { LiveAction, LiveContext, LiveEffect, LiveEvent, LiveState, LoggedAction } from "./liveStore";
import { InkStroke } from "./liveTypes";
import { ConstraintResult } from "./overlapEngine";
import { TemplateLibrary } from "./rotationTemplate";
import { RuleCourtProfile } from "./ruleCourtProfile";
import { TestTeam, matchStartedRecord, run } from "./testSupport";

function makeState(): [LiveState, TestTeam] {
  const home = new TestTeam();
  const away = new TestTeam();
  const state = new LiveState({
    setup: { profileName: "FIVB senior indoor", home: home.sheet, opponent: away.sheet, firstServer: "opponent",
             mode: "solo", templateID: "5-1-outside-follows-setter" },
    profile: RuleCourtProfile.fivbSenior(),
    template: TemplateLibrary.shipped("5-1-outside-follows-setter"),
  });
  return [state, home];
}

describe("LiveStateTests", () => {
  it("swipe, undo and redo are exact", () => {
    const [s] = makeState();
    s.reduce(LiveEvent.pointSwipe("home"));
    s.reduce(LiveEvent.pointSwipe("home"));
    expect(s.match.current.score).toEqual({ home: 2, opponent: 0 });
    expect(s.match.rotationNumber("home")).toBe(6);
    s.reduce(LiveEvent.undo);
    s.reduce(LiveEvent.undo);
    expect(s.match.current.score).toEqual({ home: 0, opponent: 0 });
    expect(s.match.rotationNumber("home")).toBe(1);
    s.reduce(LiveEvent.redo);
    expect(s.match.current.score).toEqual({ home: 1, opponent: 0 });
    expect(s.match.rotationNumber("home")).toBe(6);
  });

  it("receiving tokens come from the verified template", () => {
    const [s] = makeState();
    const tokens = s.tokens().filter((t) => t.side === "home");
    expect(tokens.length).toBe(6);
    // Home receives in R1: OH1 passes in the left lane at (2.2, 5.0) (Appendix A2).
    const p2 = tokens.find((t) => t.position === 2);
    expect(p2).toBeDefined();
    expect(p2!.point).toEqual({ l: 2.2, d: 5.0 });
    expect(s.currentConstraints("home").every(ConstraintResult.isLegal)).toBe(true);
  });

  it("dragging into an overlap reports a fault", () => {
    const [s] = makeState();
    // Move P5 (OH2 at d 5.4) in front of P4 (OPP at d 0.6).
    const effects = s.reduce(LiveEvent.moveToken("home", 5, { l: 4.5, d: 0.3 }));
    expect(effects).toContainEqual(LiveEffect.haptic("overlapFault"));
    expect(s.currentConstraints("home").some((r) => !ConstraintResult.isLegal(r) && r.a === 4 && r.b === 5)).toBe(true);
  });

  it("journal replay reproduces the state", () => {
    const [s, home] = makeState();
    const records: JournalRecord[] = [matchStartedRecord(s)];
    run(s, records, LiveEvent.pointSwipe("home"));
    run(s, records, LiveEvent.scoutTap("opponent", { l: 1, d: 1 }, 1));
    run(s, records, LiveEvent.scoutTap("home", { l: 2, d: 7 }, 2));
    run(s, records, LiveEvent.pointSwipe("opponent"));
    run(s, records, LiveEvent.substitution("home", home.oh2, home.bench));
    run(s, records, LiveEvent.undo);
    run(s, records, LiveEvent.pointSwipe("opponent"));
    const replayed = LiveState.replay(records, s.profile, { template: s.template });
    expect(replayed).toBeDefined();
    expect(replayed!.match).toEqual(s.match);
    expect(replayed!.scoutLines).toEqual(s.scoutLines);
    expect(replayed!.nextSeq).toBe(s.nextSeq);
  });

  it("panic freezes scouting and returns to live", () => {
    const [s] = makeState();
    s.reduce(LiveEvent.scoutTap("opponent", { l: 1, d: 1 }, 0));
    const effects = s.reduce(LiveEvent.panicPressed(1));
    expect(effects).toContainEqual(LiveEffect.haptic("panic"));
    expect(s.scout.state).toEqual({ kind: "idle" });
    const rejected = s.reduce(LiveEvent.pointSwipe("home"));
    expect(rejected).toEqual([LiveEffect.haptic("rejected")]);
    s.reduce(LiveEvent.ink(InkStroke.make([{ x: 0, z: 1 }, { x: 1, z: 2 }])));
    s.reduce(LiveEvent.panicDone);
    expect(s.context).toEqual({ kind: "live" });
    expect(s.ink.length).toBe(1);
  });

  it("clone keeps the original untouched and actions keep Swift's Codable shape (web)", () => {
    const [s, home] = makeState();
    s.reduce(LiveEvent.pointSwipe("home"));
    const copy = s.clone();
    copy.reduce(LiveEvent.pointSwipe("home"));
    copy.reduce(LiveEvent.undo);
    copy.reduce(LiveEvent.undo);
    expect(s.match.current.score).toEqual({ home: 1, opponent: 0 });
    expect(s.log.every((e) => e.active)).toBe(true);

    expect(LiveAction.encode({ kind: "rally", winner: "home" })).toEqual({ rally: { _0: "home" } });
    expect(LiveAction.encode({ kind: "nextSet", firstServer: undefined, homeStartRotation: 4 })).toEqual({ nextSet: { _1: 4 } });
    expect(LiveContext.encode(LiveContext.panicTimeOut(3))).toEqual({ panicTimeOut: { startedAt: 3 } });
    expect(LiveContext.encode(LiveContext.live)).toEqual({ live: {} });
    const actions: LiveAction[] = [
      { kind: "substitution", side: "home", outgoing: home.oh2, incoming: home.bench },
      { kind: "rotationCorrection", side: "opponent", setterPosition: 3, serving: undefined },
      { kind: "ink", stroke: InkStroke.make([{ x: 0, z: 1 }]) },
    ];
    for (const action of actions) {
      const logged = { seq: 9, action, active: false };
      expect(LoggedAction.decode(JSON.parse(JSON.stringify(LoggedAction.encode(logged))))).toEqual(logged);
    }
    expect(LiveContext.decode({ setBreak: {} })).toEqual(LiveContext.setBreak);
  });

  it("time-outs are counted per set, undone and replayed (web)", () => {
    const [s, home] = makeState();
    const records: JournalRecord[] = [matchStartedRecord(s)];
    run(s, records, LiveEvent.timeOut("opponent"));
    run(s, records, LiveEvent.pointSwipe("home"));
    run(s, records, LiveEvent.timeOut("home"));
    run(s, records, LiveEvent.timeOut("home"));
    expect(s.match.timeOutsLeft("home")).toBe(0);
    expect(s.match.timeOutsLeft("opponent")).toBe(1);
    // A third one is refused and writes nothing.
    const before = records.length;
    expect(run(s, records, LiveEvent.timeOut("home"))).toEqual([LiveEffect.haptic("rejected")]);
    expect(records.length).toBe(before);
    expect(s.lastAction?.action).toEqual({ kind: "timeOut", side: "home" });
    run(s, records, LiveEvent.undo);
    expect(s.match.timeOutsLeft("home")).toBe(1);
    run(s, records, LiveEvent.substitution("home", home.oh2, home.bench));
    const replayed = LiveState.replay(records, s.profile, { template: s.template })!;
    expect(replayed.match).toEqual(s.match);
    expect(replayed.log).toEqual(s.log);
    expect(replayed.match.timeOutsLeft("home")).toBe(1);
    // After reopening, undo takes back the same actions in the same order.
    for (const state of [s, replayed]) {
      state.reduce(LiveEvent.undo);
      state.reduce(LiveEvent.undo);
    }
    expect(replayed.match).toEqual(s.match);
    expect(s.match.timeOutsLeft("home")).toBe(2);
    expect(s.match.current.score).toEqual({ home: 1, opponent: 0 });
  });

  it("the panic time-out counts as a home time-out (web)", () => {
    const [s] = makeState();
    const records: JournalRecord[] = [matchStartedRecord(s)];
    run(s, records, LiveEvent.timeOut("home"));
    run(s, records, LiveEvent.panicPressed(1));
    run(s, records, LiveEvent.panicDone);
    expect(s.match.timeOutsLeft("home")).toBe(0);
    run(s, records, LiveEvent.panicPressed(2));   // none left: the board still freezes, nothing is counted
    expect(s.context.kind).toBe("panicTimeOut");
    run(s, records, LiveEvent.panicDone);
    const replayed = LiveState.replay(records, s.profile, { template: s.template })!;
    expect(replayed.log).toEqual(s.log);
    expect(replayed.match).toEqual(s.match);
  });

  it("no substitution or time-out once the set is over (web)", () => {
    const [s, home] = makeState();
    for (let i = 0; i < 25; i++) s.reduce(LiveEvent.pointSwipe("home"));
    expect(s.substitutionRefusal("home", home.oh2, home.bench)).toBe("setOver");
    expect(s.reduce(LiveEvent.substitution("home", home.oh2, home.bench))).toEqual([LiveEffect.haptic("rejected")]);
    expect(s.reduce(LiveEvent.timeOut("opponent"))).toEqual([LiveEffect.haptic("rejected")]);
    s.reduce(LiveEvent.startNextSet());
    expect(s.substitutionRefusal("home", home.oh2, home.bench)).toBeUndefined();
    expect(LiveAction.decode(LiveAction.encode({ kind: "timeOut", side: "opponent" }))).toEqual({ kind: "timeOut", side: "opponent" });
    expect(LiveAction.encode({ kind: "timeOut", side: "home" })).toEqual({ timeOut: { _0: "home" } });
  });
});
