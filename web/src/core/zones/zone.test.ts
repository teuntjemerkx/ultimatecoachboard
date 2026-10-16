// Port of CoachBoardCoreTests/ZoneTests.swift (ZoneSDFTests, ZoneSnappingTests, SceneEditorTests).
import { describe, expect, it } from "vitest";
import { CourtFrame, type FloorPoint } from "../match/court";
import { TemplateLibrary } from "../match/rotationTemplate";
import { expectClose, SplitMix64 } from "../spatial/testSupport";
import { SceneEditor, TacticalScene } from "./tacticalScene";
import { Zone, ZoneExtrusion, ZoneGeometry, ZoneSDF, ZoneSemantic, ZoneTag } from "./zone";
import { ZoneBuilder, ZoneSnapping } from "./zoneBuilder";

describe("ZoneSDFTests", () => {
  /** Brute force: distance to a densely sampled boundary, signed by containment. */
  const bruteForce = (zone: Zone, p: FloorPoint, inside: boolean): number => {
    const ring = ZoneSDF.outline(zone.geometry, 4000);
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const ex = b.x - a.x, ez = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / Math.max(ex * ex + ez * ez, 1e-12)));
      best = Math.min(best, Math.hypot(p.x - (a.x + ex * t), p.z - (a.z + ez * t)));
    }
    return inside ? -best : best;
  };

  it("exact distances against sampled boundaries", () => {
    const rng = new SplitMix64(11);
    const r = (lo: number, hi: number): number => lo + ((hi - lo) * rng.nextMod(100_000)) / 100_000;
    const zones = [
      Zone.create({ geometry: ZoneGeometry.ellipse({ x: 0.5, z: 4 }, 2.2, 1.1, 0.6) }),
      Zone.create({ geometry: ZoneGeometry.ellipse({ x: -1, z: -3 }, 0.8, 1.9, -1.1) }),
      Zone.create({ geometry: ZoneGeometry.rect({ x: 1, z: 2 }, 1.5, 0.75, 0.3) }),
      Zone.create({ geometry: ZoneGeometry.circle({ x: 0, z: 0 }, 1.25) }),
      Zone.create({ geometry: ZoneGeometry.polygon([{ x: -2, z: 1 }, { x: 2, z: 1.5 }, { x: 0.5, z: 4 }, { x: -1.5, z: 3 }]) }),
    ];
    for (const zone of zones) {
      for (let n = 0; n < 200; n++) {
        const c = Zone.centroid(zone);
        const x = c.x + r(-3, 3);
        const z = c.z + r(-3, 3);
        const p = { x, z };
        const d = Zone.distance(zone, p);
        const expected = bruteForce(zone, p, d < 0);
        expectClose(d, expected, 0.004, `${JSON.stringify(zone.geometry)} at ${JSON.stringify(p)}`);
      }
    }
  });

  it("freeform is closed and contains its centre", () => {
    const ring = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * 2 * Math.PI;
      return { x: 2 + 1.5 * Math.cos(a) + 0.2 * Math.cos(3 * a), z: 5 + 1.0 * Math.sin(a) };
    });
    const zone = Zone.create({ geometry: ZoneGeometry.freeform(ring) });
    expect(Zone.contains(zone, { x: 2, z: 5 })).toBe(true);
    expect(Zone.contains(zone, { x: 4.2, z: 5 })).toBe(false);
  });

  it("tag defaults", () => {
    expect(ZoneTag.defaultStyle("noFly").pattern).toBe("crossHatch");
    expect(ZoneTag.defaultStyle("noFly").extrusion).toEqual(ZoneExtrusion.wall(0.5));
    expect(ZoneTag.defaultStyle("serveTarget").extrusion).toEqual(ZoneExtrusion.cylinder(1.5));
    expect(ZoneTag.defaultStyle("tipAlert").edge).toBe("dashed");
  });
});

describe("ZoneSnappingTests", () => {
  const loop = (c: FloorPoint, r: number, wobble: number, phase = 0.4): FloorPoint[] =>
    Array.from({ length: 120 }, (_, i) => {
      const a = (i / 119) * 2 * Math.PI * 1.04 + phase;
      const rr = r * (1 + wobble * Math.sin(3 * a + 1));
      return { x: c.x + rr * Math.cos(a), z: c.z + rr * Math.sin(a) };
    });

  it("seam example from the blueprint", () => {
    // A wobbly loop over the opponent's P4/P5 seam: (l 1.5, d 4.5) in the opponent frame (Section 3.5.3).
    const seam = CourtFrame.world({ l: 1.5, d: 4.5 }, "opponent");
    const stroke = loop({ x: seam.x + 0.12, z: seam.z - 0.1 }, 1.2, 0.015);
    const result = ZoneBuilder.build(stroke, { tag: "tipAlert" });
    expect(result).toBeDefined();
    expect(result!.kind).toBe("circle");
    const g = result!.zone.geometry;
    if (!("circle" in g)) return expect.fail("not a circle");
    expectClose(g.circle.center.x, seam.x, 1e-9);
    expectClose(g.circle.center.z, seam.z, 1e-9);
    expectClose(g.circle.radius, 1.25, 1e-9);
    expect(result!.zone.style.edge).toBe("dashed"); // Tip/Dump Alert default style
    expect(Zone.side(result!.zone)).toBe("opponent");
  });

  it("near-cell rectangle becomes the cell", () => {
    // Home zone 1 is x 1.5...4.5, z 6...9 (world). Draw it 4 degrees off with edges up to 0.2 m out.
    const zone = Zone.create({ geometry: ZoneGeometry.rect({ x: 3.05, z: 7.4 }, 1.6, 1.45, (4 * Math.PI) / 180) });
    const [snapped, hits] = ZoneSnapping.snap(zone);
    expect(snapped.geometry).toEqual(ZoneGeometry.rect({ x: 3, z: 7.5 }, 1.5, 1.5, 0));
    expect(hits).toContainEqual({ kind: "cell", min: { x: 1.5, z: 6 }, max: { x: 4.5, z: 9 } });
  });

  it("edges snap to court lines and rotated rectangles stay", () => {
    const zone = Zone.create({ geometry: ZoneGeometry.rect({ x: 0.4, z: 1.45 }, 2.5, 1.6, 0) });
    const [snapped] = ZoneSnapping.snap(zone);
    const g = snapped.geometry;
    if (!("rect" in g)) return expect.fail("not a rect");
    expectClose(g.rect.center.z - g.rect.halfDepth, 0, 1e-9); // centre line
    expectClose(g.rect.center.z + g.rect.halfDepth, 3, 1e-9); // attack line
    const tilted = Zone.create({ geometry: ZoneGeometry.rect({ x: 0, z: 4 }, 1, 0.5, 0.5) });
    expect(ZoneSnapping.snap(tilted)[0].geometry).toEqual(tilted.geometry);
  });

  it("centre snaps to a nearby token", () => {
    const token = { x: -2.2, z: 5.3 };
    const stroke = loop({ x: -2.0, z: 5.4 }, 0.9, 0.01);
    const result = ZoneBuilder.build(stroke, { tag: "responsibility", tokens: [token] });
    const g = result!.zone.geometry;
    if (!("circle" in g)) return expect.fail("not a circle");
    expect(g.circle.center).toEqual(token);
    expectClose(g.circle.radius, 1.0, 1e-9);
  });

  it("forced shape and no snapping", () => {
    const stroke = loop({ x: 1, z: 4.4 }, 1.0, 0.01);
    const rect = ZoneBuilder.build(stroke, { forced: "rect", snapping: false });
    expect(rect && "rect" in rect.zone.geometry, "not a rect").toBe(true);
    const free = ZoneBuilder.build(stroke, { forced: "freeform", snapping: false });
    const fg = free!.zone.geometry;
    if (!("freeform" in fg)) return expect.fail("not freeform");
    expect(fg.freeform._0.length).toBe(16);
    const exact = ZoneBuilder.build(stroke, { snapping: false });
    const eg = exact!.zone.geometry;
    if (!("circle" in eg)) return expect.fail("not a circle");
    expect(eg.circle.radius).not.toBe(1.0); // no quantization without snapping
  });
});

describe("SceneEditorTests", () => {
  const makeScene = (): TacticalScene => {
    const t = TemplateLibrary.template("5-1-outside-follows-setter");
    return TacticalScene.fromFormations({ title: "R1", home: t, homeRotation: 1, homePhase: "receive", opponent: t, opponentRotation: 1 });
  };

  it("formation scene has both teams", () => {
    const s = makeScene();
    expect(s.tokens.filter((t) => t.side === "home").length).toBe(6);
    expect(s.tokens.filter((t) => t.side === "opponent").length).toBe(6);
    // Home OH1 receives in P2 at (2.2, 5.0), opponent server stands 1 m behind its end line.
    const oh1 = s.tokens.find((t) => t.side === "home" && t.role === "OH1")!;
    expect(oh1.point).toEqual(CourtFrame.world({ l: 2.2, d: 5.0 }, "home"));
    expect(s.tokens.some((t) => t.side === "opponent" && Math.abs(t.point.z) === 10)).toBe(true);
  });

  it("edits undo and redo exactly", () => {
    const e = new SceneEditor(makeScene());
    const original = e.scene;
    const zone = Zone.create({ geometry: ZoneGeometry.circle({ x: 1, z: -4.5 }, 1.25), semantic: ZoneSemantic.create("tipAlert") });
    e.addZone(zone);
    e.moveZone(zone.id, 0.5, -1);
    e.setTag("noFly", zone.id);
    expect(e.scene.zones[0]?.style.pattern).toBe("crossHatch");
    expect(e.zoneAt({ x: 1.5, z: -5.5 })?.id).toBe(zone.id);
    const token = e.scene.tokens[0];
    e.moveToken(token.id, { x: 0, z: 2 });
    e.undo();
    e.undo();
    e.undo();
    e.undo();
    expect(e.scene.zones).toEqual(original.zones);
    expect(e.scene.tokens).toEqual(original.tokens);
    expect(e.canUndo).toBe(false);
    e.redo();
    e.redo();
    const g = e.scene.zones[0]?.geometry;
    if (!g || !("circle" in g)) return expect.fail("not a circle");
    expect(g.circle.center).toEqual({ x: 1.5, z: -5.5 });
    e.deleteZone(zone.id);
    expect(e.canRedo).toBe(false); // a new edit clears the redo stack
    expect(e.scene.zones.length).toBe(0);
  });

  it("scenes round-trip as JSON", () => {
    const e = new SceneEditor(makeScene());
    e.addZone(Zone.create({ geometry: ZoneGeometry.polygon([{ x: -4.5, z: 3 }, { x: 0, z: 3 }, { x: -2, z: 6 }]) }));
    e.addZone(Zone.create({ geometry: ZoneGeometry.ellipse({ x: 0, z: 7 }, 2, 1, 0.3), semantic: ZoneSemantic.create("serveTarget") }));
    e.addInk({ points: [{ x: 0, z: 1 }, { x: 1, z: 2 }], width: 0.06 });
    const data = JSON.stringify(TacticalScene.encode(e.scene));
    expect(TacticalScene.equals(TacticalScene.decode(data), e.scene)).toBe(true);
    // Swift's Codable shape: enums with associated values as {"case": {...}}, unlabeled values as "_0".
    const json = JSON.parse(data);
    expect(json.zones[0].geometry.polygon._0.length).toBe(3);
    expect(json.zones[1].style.extrusion).toEqual({ cylinder: { height: 1.5 } });
    expect(typeof json.createdAt).toBe("number");
  });
});
