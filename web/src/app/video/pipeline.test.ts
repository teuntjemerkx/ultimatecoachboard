import { describe, expect, it } from "vitest";
import { pickBalls, samplePlan, sameFrame, withoutFixtures } from "./pipeline";

/** A ball thrown across a 600 px frame at 30 frames a second, with an antenna top the detector likes better. */
function flight(seconds: number) {
  return Array.from({ length: Math.round(seconds * 30) + 1 }, (_, k) => {
    const t = k / 30;
    return {
      time: t,
      balls: [
        { x: 514, y: 108, score: 0.45 },
        { x: 100 + 300 * t, y: 200 - 400 * t + 300 * t * t, score: k % 3 === 0 ? 0.3 : 0.15 },
      ],
    };
  });
}

describe("Video to 3D ball sampling", () => {
  it("reads two ball-only frames between each two pose frames", () => {
    const plan = samplePlan(2, 3);
    expect(plan.filter((s) => s.pose).map((s) => +s.time.toFixed(3))).toEqual([2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3]);
    expect(plan.length).toBe(31);
    plan.slice(1).forEach((s, i) => expect(s.time - plan[i].time).toBeCloseTo(1 / 30, 9));
    expect(plan.slice(0, 4).map((s) => s.pose)).toEqual([true, false, false, true]);
    expect(samplePlan(0, 1, 10, 0).every((s) => s.pose)).toBe(true);
  });

  it("drops candidates that stay put for a second, not a ball near the top of its flight", () => {
    const frames = flight(1.5);
    // The ball hangs at the top of a set for a few frames.
    for (const k of [20, 21, 22]) frames[k].balls[1] = { x: 300, y: 60, score: 0.3 };
    const kept = withoutFixtures(frames, 600);
    expect(kept.every((b) => b.every((c) => c.x !== 514))).toBe(true);
    expect(kept[21]).toEqual([{ x: 300, y: 60, score: 0.3 }]);
    expect(kept.every((b) => b.length === 1)).toBe(true);
  });

  it("follows the ball through weak detections and ignores a fixed light", () => {
    const frames = flight(1);
    const picked = pickBalls(frames, 600);
    expect(picked.every((p, k) => p !== undefined && Math.abs(p.x - frames[k].balls[1].x) < 1e-9)).toBe(true);
    // A weak candidate alone does not start a path.
    expect(pickBalls([{ time: 0, balls: [{ x: 50, y: 50, score: 0.15 }] }], 600)).toEqual([undefined]);
  });

  it("tells a repeated frame from a new one", () => {
    const a = new Uint8ClampedArray(4 * 100).fill(120);
    const b = a.slice();
    b[40] = 128;
    expect(sameFrame(a, b)).toBe(true);
    for (let i = 0; i < 40; i += 4) b[i] = 140;
    expect(sameFrame(a, b)).toBe(false);
  });
});
