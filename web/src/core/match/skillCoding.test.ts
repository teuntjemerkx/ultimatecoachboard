// Port of SkillCodingTests (SystemsAndLogTests.swift).
import { describe, expect, it } from "vitest";
import type { Side } from "./court";
import type { JournalRecord } from "./journal";
import { LiveEvent, LiveState } from "./liveStore";
import { MatchLog } from "./matchLog";
import { TeamInSet, newPlayerID } from "./matchState";
import { TemplateLibrary } from "./rotationTemplate";
import { RuleCourtProfile } from "./ruleCourtProfile";
import { SkillCode, SkillGrade, SkillLine, SkillPredictor, SkillStats, type Skill } from "./skillCoding";
import { TestTeam, expectClose, matchStartedRecord, run } from "./testSupport";

function makeState(): [LiveState, TestTeam, TestTeam] {
  const home = new TestTeam();
  const away = new TestTeam();
  const state = new LiveState({
    setup: { profileName: "FIVB senior indoor", home: home.sheet, opponent: away.sheet, firstServer: "opponent",
             mode: "advanced", templateID: "5-1-outside-follows-setter" },
    profile: RuleCourtProfile.fivbSenior(),
    template: TemplateLibrary.shipped("5-1-outside-follows-setter"),
  });
  return [state, home, away];
}

describe("SkillCodingTests", () => {
  it("codes are journalled, undone and replayed", () => {
    const [s, home, away] = makeState();
    const records: JournalRecord[] = [matchStartedRecord(s)];
    run(s, records, LiveEvent.skill("opponent", away.s, "S", "!"));
    const effects = run(s, records, LiveEvent.skill("home", home.oh1, "R", "+"));
    expect(effects.some((e) => e.kind === "journal" && e.type === 0x000D)).toBe(true);
    expect(s.codesThisRally.map(SkillCode.code)).toEqual(["S!", "R+"]);
    run(s, records, LiveEvent.skill("home", home.oh2, "A", "="));
    run(s, records, LiveEvent.undo);
    expect(s.skillCodes.length).toBe(2);
    run(s, records, LiveEvent.skill("home", home.oh2, "A", "#"));
    run(s, records, LiveEvent.pointSwipe("home"));
    expect(s.codesThisRally).toEqual([]);
    expect(s.skillCodes[s.skillCodes.length - 1].score).toEqual({ home: 0, opponent: 0 });   // coded before the rally ended
    const replayed = LiveState.replay(records, s.profile);
    expect(replayed).toBeDefined();
    expect(replayed!.skillCodes).toEqual(s.skillCodes);
    const rows = MatchLog.rows(replayed!, records);
    expect(rows[0]?.skills.map(SkillCode.code)).toEqual(["S!", "R+", "A#"]);
  });

  it("predictor and stats", () => {
    const p = newPlayerID();
    const code = (side: Side, skill: Skill): SkillCode => ({
      side, player: p, skill, grade: "+", setNumber: 1, score: { home: 0, opponent: 0 }, homeRotation: 1, opponentRotation: 1,
    });
    expect(SkillPredictor.next({ side: "home", isServer: true, isFrontRow: false, role: "OH1", serving: "home",
                                 codesThisRally: [] })).toBe("S");
    expect(SkillPredictor.next({ side: "home", isServer: false, isFrontRow: false, role: "OH1", serving: "opponent",
                                 codesThisRally: [] })).toBe("R");
    expect(SkillPredictor.next({ side: "home", isServer: false, isFrontRow: true, role: "MB2", serving: "home",
                                 codesThisRally: [] })).toBe("B");
    const received = [code("opponent", "S"), code("home", "R")];
    expect(SkillPredictor.next({ side: "home", isServer: false, isFrontRow: true, role: "S", serving: "opponent",
                                 codesThisRally: received })).toBe("E");
    expect(SkillPredictor.next({ side: "home", isServer: false, isFrontRow: true, role: "OH2", serving: "opponent",
                                 codesThisRally: received })).toBe("A");
    expect(SkillPredictor.next({ side: "opponent", isServer: false, isFrontRow: true, role: "MB1", serving: "opponent",
                                 codesThisRally: [...received, code("home", "A")] })).toBe("B");

    const line = SkillLine.make();
    line.counts = { "#": 5, "+": 2, "!": 1, "/": 1, "=": 1 };
    expect(SkillLine.total(line)).toBe(10);
    expectClose(SkillLine.positiveRate(line) ?? 0, 0.7, 1e-9);
    expectClose(SkillLine.efficiency(line) ?? 0, 0.3, 1e-9);
  });

  it("ring preview loads any rotation and phase", () => {
    const [s, home] = makeState();
    const preview = s.previewing(4, "receive");
    expect(preview.match.rotationNumber("home")).toBe(4);
    expect(TeamInSet.playerAt(preview.match.current.home, 4)).toBe(home.s);
    const p4 = preview.tokens().find((t) => t.side === "home" && t.position === 4);
    expect(p4).toBeDefined();
    expect(p4!.point).toEqual({ l: 0.9, d: 0.5 });                 // Appendix A2, R4 receive
    expect(s.match.rotationNumber("home")).toBe(1);                 // the live state is untouched
    const serve = s.previewing(2, "serve");
    expect(serve.match.current.serving).toBe("home");
    expect(serve.tokens().find((t) => t.side === "home" && t.position === 1)?.point.d).toBe(10.0);
  });

  it("stats tables, grades and the Codable shape (web)", () => {
    const a = newPlayerID();
    const b = newPlayerID();
    const codes: SkillCode[] = [
      { side: "home", player: a, skill: "A", grade: "#", setNumber: 1, score: { home: 0, opponent: 0 }, homeRotation: 1, opponentRotation: 1 },
      { side: "home", player: a, skill: "A", grade: "=", setNumber: 2, score: { home: 3, opponent: 1 }, homeRotation: 6, opponentRotation: 1 },
      { side: "home", player: b, skill: "R", grade: "+", setNumber: 1, score: { home: 0, opponent: 0 }, homeRotation: 1, opponentRotation: 1 },
      { side: "opponent", player: b, skill: "S", grade: "#", setNumber: 1, score: { home: 0, opponent: 0 }, homeRotation: 1, opponentRotation: 1 },
    ];
    const table = SkillStats.table(codes, "home");
    expect(SkillLine.total(table[a].A!)).toBe(2);
    expect(SkillStats.table(codes, "home", 1)[a].A!.counts).toEqual({ "#": 1 });
    expect(SkillStats.team(codes, "home").R!.counts).toEqual({ "+": 1 });
    expect(SkillGrade.symbol("-")).toBe("−");
    expect(SkillCode.encode(codes[1])).toEqual({ side: "home", player: a, skill: "A", grade: "=", setNumber: 2,
                                                 score: { home: 3, opponent: 1 }, homeRotation: 6, opponentRotation: 1 });
    expect(SkillCode.decode(JSON.parse(JSON.stringify(SkillCode.encode(codes[1]))))).toEqual(codes[1]);
  });
});
