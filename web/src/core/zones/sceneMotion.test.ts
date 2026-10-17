import { describe, expect, it } from "vitest";
import { AttackOption, SceneSetup, TacticalScene, sceneClock, sceneFrame, sceneMotion, sceneTimeline, secondsPerPhase } from ".";

function rallies(): TacticalScene[] {
  const out: TacticalScene[] = [];
  for (const rotation of [1, 2, 3, 4, 5, 6]) {
    for (const homeServes of [true, false]) {
      for (const attack of AttackOption.allCases) {
        const setup = SceneSetup.create({ homeRotation: rotation, opponentRotation: rotation, homeServes, attack });
        out.push(TacticalScene.playOut(TacticalScene.placed("t", setup), attack));
      }
    }
  }
  return out;
}

describe("Scene motion", () => {
  it("plays a phase in 1.1 s, longer when someone has farther to run, and nobody outruns a sprint", () => {
    let fastest = 0;
    for (const scene of rallies()) {
      const clock = sceneClock(scene);
      const end = sceneTimeline(scene).length - 1;
      expect(clock.durations.length).toBe(end);
      for (const d of clock.durations) expect(d).toBeGreaterThanOrEqual(secondsPerPhase);
      // On screen at 60 frames a second.
      let previous = sceneFrame(scene, 0);
      for (let s = 1 / 60; s <= clock.total + 1e-9; s += 1 / 60) {
        const frame = sceneFrame(scene, clock.time(s));
        for (const t of frame.tokens) {
          const p = previous.tokens.find((q) => q.id === t.id)!;
          fastest = Math.max(fastest, Math.hypot(t.point.x - p.point.x, t.point.z - p.point.z) * 60);
        }
        previous = frame;
      }
    }
    expect(fastest).toBeLessThan(7);
  });

  it("maps timeline positions to seconds and back", () => {
    const [scene] = rallies();
    const clock = sceneClock(scene);
    expect(clock.seconds(0)).toBe(0);
    expect(clock.seconds(sceneTimeline(scene).length - 1)).toBeCloseTo(clock.total, 9);
    for (let t = 0; t <= sceneTimeline(scene).length - 1; t += 0.137) expect(clock.time(clock.seconds(t))).toBeCloseTo(t, 9);
  });

  it("moves the step cycle on with the ground covered, and stands still at the markers", () => {
    const [scene] = rallies();
    const end = sceneTimeline(scene).length - 1;
    for (const t of scene.tokens) {
      let previous = sceneMotion(scene, 0).get(t.id)!;
      expect(Math.hypot(previous.velocity.x, previous.velocity.z)).toBe(0);
      for (let time = 0.05; time <= end; time += 0.05) {
        const m = sceneMotion(scene, time).get(t.id)!;
        expect(m.phase).toBeGreaterThanOrEqual(previous.phase - 1e-9);
        previous = m;
      }
      // At a marker the easing has brought every player to a stop.
      for (let marker = 1; marker < end; marker++) {
        const m = sceneMotion(scene, marker).get(t.id)!;
        expect(Math.hypot(m.velocity.x, m.velocity.z)).toBeLessThan(0.35);
      }
    }
  });
});
