// Port of CoachBoardCoreTests/TimelineTests.swift.
import { describe, expect, it } from "vitest";
import { criticallyDamped } from "../spatial/boardCamera";
import { Joint, BodyMetrics, Posture, SkeletonModel, allJoints } from "../spatial/skeleton";
import { expectClose, strideThrough } from "../spatial/testSupport";
import { RallyPhase, Timeline, TokenKey, ZoneInterpolation, ZoneKey } from "./sceneTimeline";
import { SceneEditor, SceneToken, TacticalScene } from "./tacticalScene";
import { Zone, ZoneGeometry, ZoneSDF } from "./zone";

const scene = (): [TacticalScene, string, string] => {
  const token = SceneToken.create({ side: "home", label: "9", role: "OH1", point: { x: 3, z: 5 } });
  const zone = Zone.create({ geometry: ZoneGeometry.circle({ x: 0, z: -4 }, 1) });
  const s = TacticalScene.create({ title: "T", tokens: [token], zones: [zone] });
  s.phases = [...RallyPhase.allCases];
  return [s, token.id, zone.id];
};

describe("TimelineTests", () => {
  it("keyframes are hit exactly at their markers", () => {
    const [s, tid, zid] = scene();
    s.tokens[0].keys = [TokenKey.create("set", { x: 1, z: 2 }, "attack")];
    s.zones[0].keys = [ZoneKey.create("attack", ZoneGeometry.circle({ x: 2, z: -5 }, 2), 0.5)];
    const atSet = TacticalScene.frame(s, 2);
    expect(atSet.tokens[0].point).toEqual({ x: 1, z: 2 });
    expect(atSet.tokens[0].posture).toBe("attack");
    expect(atSet.postureBlends.get(tid)).toBeUndefined();
    const atAttack = TacticalScene.frame(s, 3);
    expect(atAttack.zones[0].geometry).toEqual(ZoneGeometry.circle({ x: 2, z: -5 }, 2));
    expectClose(atAttack.intensities.get(zid)!, 0.5, 1e-12);
    expectClose(atAttack.zones[0].style.opacity, s.zones[0].style.opacity * 0.5, 1e-12);
    // Before the first key the base holds; after the last key the last key holds.
    expect(TacticalScene.frame(s, 0).tokens[0].point).toEqual({ x: 3, z: 5 });
    expect(TacticalScene.frame(s, 5).tokens[0].point).toEqual({ x: 1, z: 2 });
    // Between markers the posture blends and the token is on its way.
    const mid = TacticalScene.frame(s, 1);
    expect(mid.postureBlends.get(tid)?.to).toBe("attack");
    expect(mid.tokens[0].point.x).toBeGreaterThan(1);
    expect(mid.tokens[0].point.x).toBeLessThan(3);
  });

  it("players ease in and out along the path, which follows arc length", () => {
    const [s] = scene();
    s.tokens[0].keys = [TokenKey.create("receive", { x: 3, z: 1 })];
    // A straight move: the point stays on the segment and its progress follows the players' stride easing, which
    // never runs faster than 1.5 times the average (the critically damped easing peaks at about 2.6).
    for (const f of strideThrough(0.1, 0.9, 0.2)) {
      const p = TacticalScene.frame(s, f).tokens[0].point;
      expectClose(p.x, 3, 1e-9);
      expectClose((5 - p.z) / 4, Timeline.stride(f), 2e-3);
    }
    let peak = 0;
    for (let f = 0; f < 1; f += 0.01) peak = Math.max(peak, (Timeline.stride(f + 0.01) - Timeline.stride(f)) / 0.01);
    expect(peak).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(Timeline.locate(0.5, [0, 1])[1]).toBeCloseTo(criticallyDamped(0.5), 12);
    // Through three keys the path is a smooth centripetal Catmull-Rom: no overshoot beyond the hull here.
    s.tokens[0].keys = [TokenKey.create("receive", { x: 1, z: 3 }), TokenKey.create("set", { x: 3, z: 1 })];
    for (const f of strideThrough(0.0, 2.0, 0.05)) {
      const p = TacticalScene.frame(s, f).tokens[0].point;
      expect(p.x).toBeGreaterThanOrEqual(0.8);
      expect(p.z).toBeLessThanOrEqual(5.0 + 1e-9);
    }
  });

  it("same-type zones interpolate parameters and angles take the short arc", () => {
    const a = ZoneGeometry.rect({ x: 0, z: 0 }, 1, 2, 0.1);
    const b = ZoneGeometry.rect({ x: 2, z: 4 }, 3, 2, Math.PI - 0.1);
    const [g, morph] = ZoneInterpolation.interpolate(a, b, 0.5);
    expect(morph).toBeUndefined();
    if (!("rect" in g)) return expect.fail(JSON.stringify(g));
    expect(g.rect.center).toEqual({ x: 1, z: 2 });
    expectClose(g.rect.halfWidth, 2, 1e-12);
    expectClose(g.rect.halfDepth, 2, 1e-12);
    // pi - 0.1 is the same rectangle as -0.1, so the short way passes through 0.
    expectClose(g.rect.angle, 0, 1e-9);
    // Circles and ellipses are one family.
    const [e, m2] = ZoneInterpolation.interpolate(ZoneGeometry.circle({ x: 0, z: 0 }, 1), ZoneGeometry.ellipse({ x: 0, z: 0 }, 3, 1, 0.4), 0.5);
    expect(m2).toBeUndefined();
    expect(e).toEqual(ZoneGeometry.ellipse({ x: 0, z: 0 }, 2, 1, 0.4));
  });

  it("polygons resample and align without swirling", () => {
    const square = [{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }];
    // The same square listed from another vertex and clockwise: alignment must make the morph a no-op.
    const shifted = [...square.slice(2), ...square.slice(0, 2)].reverse();
    const [g] = ZoneInterpolation.interpolate(ZoneGeometry.polygon(square), ZoneGeometry.polygon(shifted), 0.5);
    if (!("polygon" in g)) return expect.fail(JSON.stringify(g));
    const key = (p: { x: number; z: number }): string => `${p.x},${p.z}`;
    expect(new Set(g.polygon._0.map(key))).toEqual(new Set(square.map(key)));
    // Different vertex counts: 64 points by arc length, evenly spaced on the perimeter.
    const triangle = [{ x: 0, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }];
    const [h, morph] = ZoneInterpolation.interpolate(ZoneGeometry.polygon(square), ZoneGeometry.polygon(triangle), 0.5);
    expect(morph).toBeUndefined();
    if (!("polygon" in h)) return expect.fail(JSON.stringify(h));
    const blend = h.polygon._0;
    expect(blend.length).toBe(ZoneInterpolation.resampleCount);
    const ring = ZoneInterpolation.resample(square, 64);
    for (let i = 0; i < 64; i++) {
      const a = ring[i], b = ring[(i + 1) % 64];
      expectClose(Math.hypot(b.x - a.x, b.z - a.z), 8.0 / 64, 1e-9);
    }
    // The halfway shape lies between the two: inside the square, containing the triangle's centre.
    expect(ZoneSDF.distance(ZoneGeometry.polygon(blend), { x: 0, z: 0.3 })).toBeLessThan(0);
    expect(ZoneSDF.distance(ZoneGeometry.polygon(blend), { x: 1.2, z: 0 })).toBeGreaterThan(0);
  });

  it("type changes blend signed distances", () => {
    const circle = ZoneGeometry.circle({ x: 0, z: 0 }, 1);
    const rect = ZoneGeometry.rect({ x: 0, z: 0 }, 2, 0.5, 0);
    const [g, morph] = ZoneInterpolation.interpolate(circle, rect, 0.25);
    expect(g).toEqual(circle);
    expect(morph).toEqual({ to: rect, t: 0.25 });
    const [s] = scene();
    s.zones[0] = Zone.create({ id: s.zones[0].id, geometry: circle, keys: [ZoneKey.create("receive", rect)] });
    const frame = TacticalScene.frame(s, 0.5);
    const m = frame.morphs.get(s.zones[0].id)!;
    expectClose(m.t, criticallyDamped(0.5), 1e-12);
    const p = { x: 1.5, z: 0 };
    expectClose(frame.distance(frame.zones[0], p), (1 - m.t) * ZoneSDF.distance(circle, p) + m.t * ZoneSDF.distance(rect, p), 1e-12);
    // At the markers there is no morph.
    expect(TacticalScene.frame(s, 1).morphs.size).toBe(0);
    expect(TacticalScene.frame(s, 1).zones[0].geometry).toEqual(rect);
  });

  it("editor writes keyframes at later markers and undoes", () => {
    const [s, tid, zid] = scene();
    const e = new SceneEditor(s);
    e.moveToken(tid, { x: 2, z: 2 }, "attack");
    expect(e.scene.tokens[0].point, "base untouched").toEqual({ x: 3, z: 5 });
    expect(e.scene.tokens[0].keys).toEqual([TokenKey.create("attack", { x: 2, z: 2 })]);
    e.moveToken(tid, { x: 4, z: 4 }, "serve");
    expect(e.scene.tokens[0].point, "first marker edits the base").toEqual({ x: 4, z: 4 });
    e.setPosture("block", tid, "set");
    const atSet = TacticalScene.frame(e.scene, 2).tokens[0];
    expect(atSet.posture).toBe("block");
    expect(e.scene.tokens[0].keys?.length).toBe(2);
    // Zones: moving at a later marker keys the translated shape that marker shows.
    e.moveZone(zid, 1, 0, "cover");
    expect(TacticalScene.frame(e.scene, 4).zones[0].geometry).toEqual(ZoneGeometry.circle({ x: 1, z: -4 }, 1));
    expect(e.scene.zones[0].geometry).toEqual(ZoneGeometry.circle({ x: 0, z: -4 }, 1));
    e.setIntensity(0, zid, "defence");
    expect(TacticalScene.frame(e.scene, 5).intensities.get(zid)).toBe(0);
    expect(TacticalScene.frame(e.scene, 5).zoneAt({ x: 1, z: -4 }), "hidden zones are not hit").toBeUndefined();
    e.clearKey(zid, "defence");
    expect(e.scene.zones[0].keys?.length).toBe(1);
    for (let i = 0; i < 6; i++) e.undo();
    expect(TacticalScene.equals(e.scene, s)).toBe(true);
  });

  it("old scenes decode without timeline fields", () => {
    const token = SceneToken.create({ side: "home", label: "9", role: "OH1", point: { x: 3, z: 5 } });
    const json = JSON.parse(JSON.stringify(TacticalScene.encode(TacticalScene.create({ title: "Old", tokens: [token],
      zones: [Zone.create({ geometry: ZoneGeometry.circle({ x: 0, z: 0 }, 1) })] }))));
    delete json.phases;
    const decoded = TacticalScene.decode(JSON.stringify(json));
    expect(decoded.phases).toBeUndefined();
    expect(TacticalScene.timeline(decoded).length).toBe(0);
    expect(TacticalScene.frame(decoded, 3).tokens[0].point).toEqual({ x: 3, z: 5 });
  });

  it("posture blend endpoints and midpoint", () => {
    const s = new SkeletonModel(new BodyMetrics(1.9));
    const at = { x: 1, z: 2 };
    const a = s.pose("ready", at, Math.PI);
    const b = s.pose("block", at, Math.PI);
    const start = s.pose({ from: "ready", to: "block", t: 0 }, at, Math.PI);
    const end = s.pose({ from: "ready", to: "block", t: 1 }, at, Math.PI);
    for (const j of allJoints) {
      expect(start[j].translation.sub(a[j].translation).length).toBeLessThan(1e-9);
      expect(end[j].translation.sub(b[j].translation).length).toBeLessThan(1e-9);
    }
    // Halfway the hands are between a ready guard and a block, and the feet stay on the floor.
    const mid = s.pose({ from: "ready", to: "block", t: 0.5 }, at, Math.PI);
    const hand = s.fingertip(mid, true).y;
    expect(hand).toBeGreaterThan(s.fingertip(a, true).y);
    expect(hand).toBeLessThan(s.fingertip(b, true).y);
    // The feet rise with the blended jump (the block posture is the block jump at its peak).
    const jump = (Posture.params("ready", s).jump + Posture.params("block", s).jump) / 2;
    expectClose(Math.min(mid[Joint.lAnkle].translation.y, mid[Joint.rAnkle].translation.y), s.ankleHeight + jump, 1e-9);
  });
});
