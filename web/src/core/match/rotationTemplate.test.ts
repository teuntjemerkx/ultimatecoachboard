// Port of AtlasTests (RulesTests.swift, route timing in routeTiming.test.ts), MiddleFollowsSetterTemplateTests
// (SystemsAndLogTests.swift) and AutopilotTests.testRotationCycles (the template rotation helpers).
import { describe, expect, it } from "vitest";
import { OverlapEngine } from "./overlapEngine";
import { RotationTemplate, TemplateError, TemplateLibrary } from "./rotationTemplate";
import { RouteCheck, RouteTiming } from "./routeTiming";
import { RuleCourtProfile } from "./ruleCourtProfile";
import { TeamSystem } from "./teamSystem";
import { expectClose } from "./testSupport";

describe("AtlasTests", () => {
  it("every shipped formation is legal and matches the atlas", () => {
    const profile = RuleCourtProfile.fivbSenior();
    for (const template of TemplateLibrary.allShipped()) {
      for (const v of TemplateLibrary.validate(template, profile)) {
        expect(v.isLegal, `${template.id} R${v.rotation} ${v.phase}: ${JSON.stringify(v.failing)}`).toBe(true);
        expect(v.matchesExpectation, `${template.id} R${v.rotation} ${v.phase} min margin ${v.minMargin}`).toBe(true);
      }
    }
  });

  it("smallest margins from Appendix A", () => {
    const t = TemplateLibrary.shipped("5-1-outside-follows-setter");
    const expected: [number, number][] = [[1, 0.70], [6, 0.70], [5, 0.40], [4, 0.70], [3, 0.60], [2, 0.60]];
    for (const [rotation, margin] of expected) {
      const f = RotationTemplate.formation(t, rotation, "receive");
      expect(f).toBeDefined();
      expectClose(OverlapEngine.minimumMargin(RotationTemplate.positions(f!), { serving: false }), margin, 0.005);
    }
  });

  it("6-2 reuses 5-1 formations", () => {
    const t = TemplateLibrary.shipped("5-1-outside-follows-setter");
    const f = TemplateLibrary.sixTwoFormation(6, t);
    expect(f).toBeDefined();
    expect(f!.players.some((p) => p.role === "S2" && p.position === 3)).toBe(true);
    expect(TemplateLibrary.sixTwoFormation(3, t)).toBeUndefined();
  });
});

describe("MiddleFollowsSetterTemplateTests", () => {
  it("smallest margins and no late routes", () => {
    const t = TemplateLibrary.shipped("5-1-middle-follows-setter");
    expect(t.lineupOrder).toEqual(["S", "MB1", "OH1", "OPP", "MB2", "OH2"]);
    const expected: [number, number][] = [[1, 0.70], [6, 0.60], [5, 0.80], [4, 0.80], [3, 0.60], [2, 2.40]];
    for (const [rotation, margin] of expected) {
      const f = RotationTemplate.formation(t, rotation, "receive");
      expect(f, `R${rotation}`).toBeDefined();
      expectClose(OverlapEngine.minimumMargin(RotationTemplate.positions(f!), { serving: false }), margin, 0.005, `R${rotation}`);
      const checks = RouteTiming.check(f!, t.routeTargets);
      expect(checks.some(RouteCheck.isLate), `R${rotation}`).toBe(false);
      const slacks = checks.map(RouteCheck.slack);
      expect(slacks.length === 0 ? 0 : Math.min(...slacks), `R${rotation}`).toBeGreaterThanOrEqual(0.25);
      expect(RotationTemplate.formation(t, rotation, "serve")).toBeDefined();
    }
  });
});

describe("AutopilotTests (template rotation helpers)", () => {
  it("rotation cycles", () => {
    const sixTwo = TemplateLibrary.template(TeamSystem.sixTwo);
    expect(RotationTemplate.nextRotation(sixTwo, 1)).toBe(6);
    expect(RotationTemplate.nextRotation(sixTwo, 5)).toBe(1);
    const fourTwo = TemplateLibrary.template(TeamSystem.fourTwo);
    expect(RotationTemplate.nextRotation(fourTwo, 4)).toBe(3);
    expect(RotationTemplate.nextRotation(fourTwo, 2)).toBe(4);
    expect(RotationTemplate.previousRotation(fourTwo, 4)).toBe(2);
    const youth = TemplateLibrary.template(TeamSystem.youthW);
    expect(RotationTemplate.nextRotation(youth, 0)).toBe(0);
  });

  it("rotations lists each template's rotations once, ascending", () => {
    expect(RotationTemplate.rotations(TemplateLibrary.template(TeamSystem.sixTwo))).toEqual([1, 5, 6]);
    expect(RotationTemplate.rotations(TemplateLibrary.template(TeamSystem.fiveOneOutside))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(RotationTemplate.rotations(TemplateLibrary.template(TeamSystem.youthW))).toEqual([0]);
  });
});

describe("TemplateLibrary loading (web)", () => {
  it("shipped templates round-trip to their JSON files (nil members omitted)", () => {
    for (const id of TemplateLibrary.shippedIDs) {
      const t = TemplateLibrary.shipped(id);
      const reloaded = TemplateLibrary.decode(JSON.stringify(RotationTemplate.encode(t)));
      expect(reloaded).toEqual(t);
    }
  });

  it("rejects missing resources, other formats and duplicate positions", () => {
    expect(() => TemplateLibrary.shipped("nope")).toThrow(TemplateError);
    const t = RotationTemplate.encode(TemplateLibrary.shipped("4-2")) as Record<string, unknown>;
    expect(() => TemplateLibrary.decode({ ...t, format: "cb.rotation-template/2" })).toThrow(TemplateError);
    const bad = TemplateLibrary.shipped("4-2");
    bad.formations[0].players[1].position = bad.formations[0].players[0].position;
    expect(() => TemplateLibrary.decode(RotationTemplate.encode(bad))).toThrow(/duplicate or invalid positions/);
  });
});
