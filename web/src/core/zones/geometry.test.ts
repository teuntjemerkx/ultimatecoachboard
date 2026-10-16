// Port of the SmartGeometryTests and SignedDistanceTests of CoachBoardCoreTests/GeometryJournalLiveTests.swift.
import { describe, expect, it } from "vitest";
import { expectClose, SplitMix64 } from "../spatial/testSupport";
import { SignedDistance } from "./signedDistance";
import { P2, SmartGeometry, type ShapeKind } from "./smartGeometry";

/** Deterministic strokes identical to the Python reference (verify/swift_test_strokes.py). */
const TestStrokes = {
  n: 180,

  linspace(a: number, b: number, n: number): number[] {
    return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
  },

  rotate(p: readonly P2[], th: number): P2[] {
    return p.map((q) => ({ x: Math.cos(th) * q.x - Math.sin(th) * q.y, y: Math.sin(th) * q.x + Math.cos(th) * q.y }));
  },

  wobble(p: readonly P2[], amp: number): P2[] {
    const t = TestStrokes.linspace(0, 1, p.length);
    return p.map((q, i) => {
      const s = t[i];
      const dx = Math.sin(6 * Math.PI * s + 0.5);
      const dy = Math.cos(4 * Math.PI * s + 1.1);
      return { x: q.x + amp * dx, y: q.y + amp * dy };
    });
  },

  polygonPath(corners: readonly P2[], over: number): P2[] {
    const c = [...corners, corners[0]];
    const s = [0];
    for (let i = 1; i < c.length; i++) s.push(s[i - 1] + P2.length(P2.sub(c[i], c[i - 1])));
    const total = s[s.length - 1];
    return TestStrokes.linspace(0, 1 + over, TestStrokes.n).map((u) => {
      const t = (u % 1.0) * total;
      let j = 0;
      while (j < s.length - 2 && s[j + 1] < t) j += 1;
      const f = (t - s[j]) / (s[j + 1] - s[j]);
      return P2.add(c[j], P2.scale(P2.sub(c[j + 1], c[j]), f));
    });
  },

  all(): { expected: ShapeKind; points: P2[] }[] {
    const n = TestStrokes.n;
    const t = TestStrokes.linspace(0, 2 * Math.PI * 1.05, n).map((v) => v + 0.3);
    const circle = TestStrokes.wobble(t.map((a) => ({ x: 2 * Math.cos(a), y: 2 * Math.sin(a) })), 0.03);
    const ellipse = TestStrokes.wobble(TestStrokes.rotate(t.map((a) => ({ x: 3 * Math.cos(a), y: 1.4 * Math.sin(a) })), 0.4), 0.03);
    const rect = TestStrokes.wobble(TestStrokes.rotate(TestStrokes.polygonPath(
      [{ x: -2, y: -1.25 }, { x: 2, y: -1.25 }, { x: 2, y: 1.25 }, { x: -2, y: 1.25 }], 0.06), 0.2), 0.02);
    const triangle = TestStrokes.wobble(TestStrokes.polygonPath([{ x: -2.0, y: -1.5 }, { x: 2.5, y: -1.0 }, { x: -0.3, y: 2.2 }], 0.06), 0.02);
    const trapezoid = TestStrokes.wobble(TestStrokes.polygonPath(
      [{ x: -2.0, y: -1.2 }, { x: 2.0, y: -1.2 }, { x: 1.0, y: 1.2 }, { x: -1.2, y: 1.2 }], 0.06), 0.02);
    const tb = TestStrokes.linspace(0, 2 * Math.PI * 1.04, n);
    const bean = tb.map((a) => {
      const r = 2 + 0.5 * Math.cos(2 * a) + 0.4 * Math.cos(3 * a + 1);
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    });
    const line = TestStrokes.wobble(TestStrokes.linspace(0, 1, n).map((v) => ({ x: 5 * v, y: 0.4 * v })), 0.01);
    const arc = TestStrokes.linspace(0, Math.PI, n).map((a) => ({ x: 2 * Math.cos(a), y: 2 * Math.sin(a) }));
    return [
      { expected: "circle", points: circle }, { expected: "ellipse", points: ellipse }, { expected: "rect", points: rect },
      { expected: "polygon", points: triangle }, { expected: "polygon", points: trapezoid }, { expected: "freeform", points: bean },
      { expected: "line", points: line }, { expected: "openPath", points: arc },
    ];
  },
};

describe("SmartGeometryTests", () => {
  it("recognizes the reference strokes", () => {
    for (const { expected, points } of TestStrokes.all()) {
      const shape = SmartGeometry.recognize(points);
      expect(shape.kind, `expected ${expected}, got ${shape.kind} (alternative ${shape.alternative})`).toBe(expected);
    }
  });

  it("circle parameters", () => {
    const t = TestStrokes.linspace(0, 2 * Math.PI, 100);
    const fit = SmartGeometry.fitCircle(t.map((a) => ({ x: 1 + 2 * Math.cos(a), y: -3 + 2 * Math.sin(a) })));
    expectClose(fit.center.x, 1, 1e-6);
    expectClose(fit.center.y, -3, 1e-6);
    expectClose(fit.radius, 2, 1e-6);
  });

  it("ellipse parameters", () => {
    const t = TestStrokes.linspace(0, 2 * Math.PI, 200);
    const pts = TestStrokes.rotate(t.map((a) => ({ x: 3 * Math.cos(a), y: 1.5 * Math.sin(a) })), 0.5).map((p) => P2.add(p, { x: 2, y: 1 }));
    const fit = SmartGeometry.fitEllipse(pts);
    expect(fit).toBeDefined();
    expectClose(fit!.center.x, 2, 1e-3);
    expectClose(fit!.center.y, 1, 1e-3);
    expectClose(fit!.semiAxes.x, 3, 1e-3);
    expectClose(fit!.semiAxes.y, 1.5, 1e-3);
    expect(fit!.rms).toBeLessThan(1e-3);
    // Major-axis direction is 0.5 rad, modulo pi.
    const delta = (fit!.angle - 0.5) % Math.PI;
    expect(Math.min(Math.abs(delta), Math.PI - Math.abs(delta))).toBeLessThan(1e-3);
  });

  it("minimum-area rectangle", () => {
    const corners = TestStrokes.rotate([{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }], 0.3);
    const rect = SmartGeometry.minAreaRect(TestStrokes.polygonPath(corners, 0));
    const area = Math.abs(SmartGeometry.cross(P2.sub(rect[1], rect[0]), P2.sub(rect[3], rect[0])));
    expectClose(area, 8, 1e-6);
  });
});

describe("SignedDistanceTests", () => {
  it("exact against brute force", () => {
    const rng = new SplitMix64(7);
    const w = 23, h = 17;
    const mask = Array.from({ length: w * h }, () => rng.nextMod(1000) / 1000 < 0.08);
    const fast = SignedDistance.squaredDistance(mask, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            if (mask[yy * w + xx]) best = Math.min(best, Math.fround((x - xx) * (x - xx) + (y - yy) * (y - yy)));
          }
        }
        expect(fast[y * w + x], `(${x}, ${y})`).toBe(best);
      }
    }
  });

  it("field of a disc", () => {
    const w = 64, h = 64;
    const coverage = Array.from({ length: w * h }, (_, i) => {
      const x = (i % w) - 31.5, y = Math.floor(i / w) - 31.5;
      return Math.sqrt(x * x + y * y) < 16 ? 255 : 0;
    });
    const sdf = SignedDistance.field(coverage, w, h, 8);
    expect(sdf[32 * w + 32]).toBe(255); // deep inside saturates
    expect(sdf[0]).toBe(0); // far outside saturates
    const edge = sdf[32 * w + 32 + 16]; // just outside the rim
    expect(edge >= 100 && edge <= 135, `edge value ${edge}`).toBe(true);
  });
});
