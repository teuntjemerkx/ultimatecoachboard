// Port of OverlapEngineTests (RulesTests.swift).
import { describe, expect, it } from "vitest";
import { CourtPosition, type LocalPoint } from "./court";
import { ConstraintResult, Footprint, OverlapEngine, type Stance } from "./overlapEngine";
import { SplitMix64, expectClose } from "./testSupport";

describe("OverlapEngineTests", () => {
  /** The worked example of blueprint Section 2.6 / Appendix A2 (5-1, R4 receive). */
  const r4 = new Map<CourtPosition, LocalPoint>([
    [4, { l: 0.9, d: 0.5 }], [3, { l: 1.7, d: 0.9 }], [2, { l: 2.4, d: 4.6 }],
    [5, { l: 4.6, d: 5.1 }], [6, { l: 6.9, d: 5.0 }], [1, { l: 8.3, d: 7.6 }],
  ]);

  it("worked example margins match reference", () => {
    const results = OverlapEngine.evaluate(r4, { serving: false });
    const expected: [CourtPosition, CourtPosition, number][] = [
      [4, 5, 4.6], [3, 6, 4.1], [2, 1, 3.0], [4, 3, 0.8], [5, 6, 2.3], [2, 3, 0.7], [1, 6, 1.4],
    ];
    expect(results.length).toBe(7);
    for (const [a, b, m] of expected) {
      const r = results.find((x) => x.a === a && x.b === b);
      expect(r).toBeDefined();
      expectClose(r!.margin, m, 1e-9, `${CourtPosition.label(a)}/${CourtPosition.label(b)}`);
    }
    expect(results.every(ConstraintResult.isLegal)).toBe(true);
  });

  it("server exemption drops pairs with P1", () => {
    const results = OverlapEngine.evaluate(r4, { serving: true });
    expect(results.length).toBe(5);
    expect(results.some((r) => r.a === 1 || r.b === 1)).toBe(false);
  });

  it("level feet are a fault", () => {
    const f = new Map(r4);
    f.set(5, { l: 4.6, d: 0.5 });   // exactly level with P4
    const r = OverlapEngine.evaluate(f, { serving: false }).find((x) => x.a === 4 && x.b === 5)!;
    expectClose(r.margin, 0, 1e-12);
    expect(ConstraintResult.isLegal(r), "level is not closer").toBe(false);
  });

  /** Property test against a literal reading of the rule on a fixed 2 mm raster (Appendix D2 uses 1 mm). */
  it("agrees with raster reference", () => {
    const rng = new SplitMix64(11);
    const grid = 0.002;
    const raster = (verts: LocalPoint[]): LocalPoint[] => {
      const out: LocalPoint[] = [];
      for (const foot of [verts.slice(0, 4), verts.slice(4, 8)]) {
        const loop = [foot[0], foot[1], foot[3], foot[2]];
        const lo = { l: Math.min(...loop.map((p) => p.l)), d: Math.min(...loop.map((p) => p.d)) };
        const hi = { l: Math.max(...loop.map((p) => p.l)), d: Math.max(...loop.map((p) => p.d)) };
        let x = Math.floor(lo.l / grid) * grid + grid / 2;
        while (x <= hi.l) {
          let y = Math.floor(lo.d / grid) * grid + grid / 2;
          while (y <= hi.d) {
            let pos = 0;
            let neg = 0;
            for (let i = 0; i < 4; i++) {
              const a = loop[i];
              const b = loop[(i + 1) % 4];
              const c = (b.l - a.l) * (y - a.d) - (b.d - a.d) * (x - a.l);
              if (c >= 0) pos += 1;
              if (c <= 0) neg += 1;
            }
            if (pos === 4 || neg === 4) out.push({ l: x, d: y });
            y += grid;
          }
          x += grid;
        }
      }
      return out;
    };
    const minOf = (cells: LocalPoint[], f: (p: LocalPoint) => number): number => {
      let m = Infinity;
      for (const p of cells) m = Math.min(m, f(p));
      return m;
    };
    let decided = 0;
    for (let iteration = 0; iteration < 120; iteration++) {
      const cl = rng.double(1.5, 7.5);
      const cd = rng.double(1.0, 7.5);
      const positions = new Map<CourtPosition, LocalPoint>();
      const stances = new Map<CourtPosition, Stance>();
      for (const p of CourtPosition.allCases) {
        const l = cl + rng.double(-0.6, 0.6);
        const d = cd + rng.double(-0.6, 0.6);
        positions.set(p, { l, d });
        const yaw = rng.double(-1.0, 1.0);
        const width = rng.double(0.2, 0.45);
        const stagger = rng.double(-0.25, 0.25);
        stances.set(p, { yaw, width, stagger });
      }
      const serving = rng.bool();
      const cells = new Map<CourtPosition, LocalPoint[]>();
      for (const p of CourtPosition.allCases) cells.set(p, raster(Footprint.vertices(positions.get(p)!, stances.get(p)!)));
      for (const r of OverlapEngine.evaluate(positions, { stances, serving })) {
        if (!(Math.abs(r.margin) > 0.004)) continue;   // undecidable at this raster
        const a = cells.get(r.a)!;
        const b = cells.get(r.b)!;
        let reference: number;
        switch (r.kind) {
          case "frontBack": reference = minOf(b, (p) => p.d) - minOf(a, (p) => p.d); break;
          case "leftCentre": reference = minOf(b, (p) => p.l) - minOf(a, (p) => p.l); break;
          case "rightCentre": reference = minOf(b, (p) => 9 - p.l) - minOf(a, (p) => 9 - p.l); break;
        }
        expect(r.margin > 0).toBe(reference > 0);
        expectClose(r.margin, reference, 0.004);
        decided += 1;
      }
    }
    expect(decided).toBeGreaterThan(500);
  }, 120_000);
});
