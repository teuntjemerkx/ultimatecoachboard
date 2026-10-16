// Port of LegalEnvelopeTests (RulesTests.swift).
import { describe, expect, it } from "vitest";
import { CourtPosition, type LocalPoint } from "./court";
import { LegalEnvelope } from "./legalEnvelope";
import { OverlapEngine } from "./overlapEngine";
import { RotationTemplate, TemplateLibrary } from "./rotationTemplate";
import { RuleCourtProfile } from "./ruleCourtProfile";
import { SplitMix64 } from "./testSupport";

describe("LegalEnvelopeTests", () => {
  it("points inside the envelope are legal and outside are not", () => {
    const profile = RuleCourtProfile.fivbSenior();
    const template = TemplateLibrary.shipped("5-1-outside-follows-setter");
    const rng = new SplitMix64(5);
    let compared = 0;
    for (const f of template.formations) {
      if (f.phase !== "receive") continue;
      const positions = RotationTemplate.positions(f);
      for (const player of CourtPosition.allCases) {
        const env = LegalEnvelope.compute(player, { positions, serving: false, profile });
        expect(LegalEnvelope.isEmpty(env), `R${f.rotation} ${CourtPosition.label(player)}`).toBe(false);
        for (let i = 0; i < 40; i++) {
          const l = rng.double(-0.5, 9.5);
          const d = rng.double(-0.5, 9.5);
          const probe: LocalPoint = { l, d };
          const moved = new Map(positions);
          moved.set(player, probe);
          const legal = OverlapEngine.isLegal(moved, { serving: false, profile });
          const inside = LegalEnvelope.contains(env, probe);
          // Points well inside or well outside must agree; points on the boundary are skipped.
          const nearEdge = Math.min(Math.abs(probe.l - env.lMin), Math.abs(probe.l - env.lMax),
                                    Math.abs(probe.d - env.dMin), Math.abs(probe.d - env.dMax)) < 1e-6;
          if (!nearEdge) {
            expect(inside, `R${f.rotation} ${CourtPosition.label(player)} at (${probe.l}, ${probe.d})`).toBe(legal);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});
