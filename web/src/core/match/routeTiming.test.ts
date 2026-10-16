// Port of AtlasTests.testRouteTimingMatchesAppendixA (RulesTests.swift).
import { describe, expect, it } from "vitest";
import { RotationTemplate, TemplateLibrary } from "./rotationTemplate";
import { RouteCheck, RouteTiming, TimingModel } from "./routeTiming";
import { expectClose } from "./testSupport";

describe("AtlasTests", () => {
  it("route timing matches Appendix A", () => {
    const t = TemplateLibrary.shipped("5-1-outside-follows-setter");
    const r1 = RotationTemplate.formation(t, 1, "receive");
    expect(r1).toBeDefined();
    const checks = RouteTiming.check(r1!, t.routeTargets);
    const opp = checks.find((c) => c.role === "OPP");
    expect(opp).toBeDefined();
    expectClose(opp!.length, 9.18, 0.005);
    expectClose(RouteCheck.slack(opp!), 0.26, 0.006);
    expect(checks.some(RouteCheck.isLate)).toBe(false);

    // The rejected variant: OH1 passing in the right lane is 0.53 s late.
    const bad = RotationTemplate.cloneFormation(r1!);
    for (const p of bad.players) {
      switch (p.role) {
        case "OH1": p.anchor = [7.0, 5.0]; break;
        case "OH2": p.anchor = [2.0, 5.0]; break;
        case "L": p.anchor = [4.5, 5.4]; break;
        default: break;
      }
    }
    const oh1 = RouteTiming.check(bad, t.routeTargets).find((c) => c.role === "OH1");
    expect(oh1).toBeDefined();
    expect(RouteCheck.isLate(oh1!)).toBe(true);
    expectClose(RouteCheck.slack(oh1!), -0.53, 0.006);
    // The variant is a copy: the template is unchanged.
    expect(RotationTemplate.formation(t, 1, "receive")!.players.find((p) => p.role === "OH1")!.anchor).toEqual([2.2, 5.0]);
  });

  it("timing model defaults and deadlines (Appendix A1)", () => {
    const m = TimingModel.make();
    expectClose(TimingModel.setTime(m), 2.3, 1e-12);
    expectClose(TimingModel.deadline(m, "target")!, 2.0, 1e-12);
    expectClose(TimingModel.deadline(m, "left")!, 2.35, 1e-12);
    expectClose(TimingModel.deadline(m, "quick")!, 1.85, 1e-12);
    expectClose(TimingModel.deadline(m, "pipe")!, 2.25, 1e-12);
    expect(TimingModel.deadline(m, "none")).toBeUndefined();
    expect(TimingModel.decode(JSON.parse(JSON.stringify(TimingModel.encode(m))))).toEqual(m);
  });
});
