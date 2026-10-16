// Port of TeamSystemTests (SystemsAndLogTests.swift).
import { describe, expect, it } from "vitest";
import { CourtPosition } from "./court";
import { LiveState } from "./liveStore";
import { MatchState } from "./matchState";
import { ConstraintResult } from "./overlapEngine";
import { RotationTemplate, TemplateLibrary } from "./rotationTemplate";
import { RuleCourtProfile } from "./ruleCourtProfile";
import { LineupBuilder, TeamSystem } from "./teamSystem";
import { PlacedTeam } from "./testSupport";
import type { MatchStartedPayload } from "./journal";

describe("TeamSystemTests", () => {
  it("roles follow the lineup order from the setter", () => {
    const order = ["S", "MB1", "OH1", "OPP", "MB2", "OH2"];
    const r1 = LineupBuilder.roles(order, 1);
    expect(CourtPosition.allCases.map((p) => r1.get(p))).toEqual(["S", "MB1", "OH1", "OPP", "MB2", "OH2"]);
    const r4 = LineupBuilder.roles(order, 4);
    expect(r4.get(4)).toBe("S");
    expect(r4.get(5)).toBe("MB1");
    expect(r4.get(1)).toBe("OPP");
  });

  it("sheet takes libero partners from the template", () => {
    const team = new PlacedTeam();
    const sheet = team.sheet(TeamSystem.fiveOneMiddle);
    expect(sheet.liberoPartners).toEqual(new Set([team.ids.get(2)!, team.ids.get(5)!]));   // MB1 and MB2
    expect(sheet.roles[team.libero]).toBe("L");
    expect(team.sheet(TeamSystem.fourTwo).liberoPartners).toEqual(new Set());              // the 4-2 template has no libero rule
  });

  it("middle follows setter tokens come from its template", () => {
    const home = new PlacedTeam();
    const away = new PlacedTeam();
    const setup: MatchStartedPayload = {
      profileName: "FIVB senior indoor", home: home.sheet(TeamSystem.fiveOneMiddle),
      opponent: away.sheet(TeamSystem.fiveOneOutside), firstServer: "opponent", mode: "solo",
      templateID: TeamSystem.fiveOneMiddle,
    };
    const s = new LiveState({ setup, profile: RuleCourtProfile.fivbSenior(),
                              template: TemplateLibrary.template(setup.templateID),
                              opponentTemplate: TemplateLibrary.template(TeamSystem.fiveOneOutside) });
    const tokens = s.tokens().filter((t) => t.side === "home");
    // R1 receive (Appendix A, middle follows setter): OH1 passes from P3 at (2.0, 4.8); the libero is in P5.
    expect(tokens.find((t) => t.position === 3)?.point).toEqual({ l: 2.0, d: 4.8 });
    const p5 = tokens.find((t) => t.position === 5);
    expect(p5).toBeDefined();
    expect(p5!.isLibero).toBe(true);
    expect(p5!.point).toEqual({ l: 4.5, d: 5.4 });
    expect(s.currentConstraints("home").every(ConstraintResult.isLegal)).toBe(true);
    // The opponent serves in its own 5-1 serve formation.
    expect(s.tokens().find((t) => t.side === "opponent" && t.position === 1)?.point.d).toBe(10.0);
  });

  it("6-2 uses the back-row setter", () => {
    const six = TemplateLibrary.template("6-2");
    const five = TemplateLibrary.shipped("5-1-outside-follows-setter");
    const home = new PlacedTeam();
    const away = new PlacedTeam();
    // S1 starts in P4, so S2 is in P1: the back-row setter is in P1 and the 5-1 R1 formation applies.
    const m = new MatchState({ profile: RuleCourtProfile.fivbSenior(), home: home.sheet(TeamSystem.sixTwo, 4),
                               opponent: away.sheet(TeamSystem.fiveOneOutside), firstServer: "opponent" });
    const positions = (f: RotationTemplate.Formation | undefined) => (f ? RotationTemplate.positions(f) : undefined);
    expect(positions(RotationTemplate.formationFor(six, m, "home", "receive")))
      .toEqual(positions(RotationTemplate.formation(five, 1, "receive")));
    m.applyRally("home");                       // side-out: S2 moves to P6
    expect(positions(RotationTemplate.formationFor(six, m, "home", "serve")))
      .toEqual(positions(RotationTemplate.formation(five, 6, "serve")));
    expect(positions(RotationTemplate.formationFor(six, m, "home", "serve"))).toBeDefined();
    for (const v of TemplateLibrary.validate(six, RuleCourtProfile.fivbSenior())) {
      expect(v.isLegal && v.matchesExpectation).toBe(true);
    }
  });

  it("4-2 uses the front-row setter and youth W is positional", () => {
    const fourTwo = TemplateLibrary.template("4-2");
    const youth = TemplateLibrary.template("youth-w");
    const home = new PlacedTeam();
    const away = new PlacedTeam();
    const m = new MatchState({ profile: RuleCourtProfile.fivbSenior(), home: home.sheet(TeamSystem.fourTwo, 1),
                               opponent: away.sheet(TeamSystem.youthW), firstServer: "opponent" });
    // S1 in P1, so S2 is the front-row setter in P4: pattern A.
    expect(RotationTemplate.formationFor(fourTwo, m, "home", "receive")?.rotation).toBe(4);
    expect(RotationTemplate.formationFor(fourTwo, m, "home", "serve")).toBeUndefined();
    expect(RotationTemplate.formationFor(youth, m, "opponent", "receive")?.rotation).toBe(0);
    expect(RotationTemplate.formationFor(youth, m, "opponent", "serve")).toBeUndefined();
    expect(m.rotationNumber("home")).toBe(1);            // named by S1
  });

  it("system names and role names", () => {
    expect(TeamSystem.allCases.map(TeamSystem.displayName))
      .toEqual(["5-1 · outside follows setter", "5-1 · middle follows setter", "6-2", "4-2", "Youth W"]);
    expect(TeamSystem.roleNames("6-2")[3]).toBe("Setter 2");
    expect(TeamSystem.hasSetter("youth-w")).toBe(false);
    expect(TeamSystem.fromRawValue("4-2")).toBe("4-2");
    expect(TeamSystem.fromRawValue("3-3")).toBeUndefined();
  });
});
