import { describe, expect, it } from "vitest";
import { InkStroke } from "../../core/match/liveTypes";
import { PlayerBodies, SeparationMoments } from "../../core/spatial";
import { SceneEditor, SceneSetup, TacticalScene, ZoneBuilder, ZoneStyle } from "../../core/zones";
import { bodyKey, bodyScene, studioTrack } from "./bodyTrack";

describe("Studio bodies", () => {
  const rally = () => {
    const editor = new SceneEditor(TacticalScene.placed("Board", SceneSetup.create({ homeRotation: 4, homeServes: true })));
    editor.playOut("middle");
    return editor;
  };

  it("depend on the players, the timeline and the ball, not on the title, names, zones or ink", () => {
    const editor = rally();
    const before = bodyKey(editor.scene);
    editor.addInk(InkStroke.make([{ x: -3, z: 2 }, { x: -1, z: 3 }, { x: 1, z: 2.5 }]));
    editor.rename("Another title");
    editor.setLabel("12", editor.scene.tokens[0].id);
    const circle = Array.from({ length: 24 }, (_, k) => ({ x: 2 + Math.cos(k / 3.8), z: 4 + Math.sin(k / 3.8) }));
    const built = ZoneBuilder.build(circle, { tag: "custom", style: ZoneStyle.create(), snapping: false, tokens: [], otherZones: [] });
    expect(built).toBeDefined();
    editor.addZone(built!.zone);
    expect(bodyKey(editor.scene)).toBe(before);
    const t = editor.scene.tokens[1];
    editor.moveToken(t.id, { x: t.point.x + 0.5, z: t.point.z });
    expect(bodyKey(editor.scene)).not.toBe(before);
    const moved = bodyKey(editor.scene);
    PlayerBodies.women = !PlayerBodies.women;
    expect(bodyKey(editor.scene)).not.toBe(moved);
    PlayerBodies.women = !PlayerBodies.women;
  });

  it("solved elsewhere from what they depend on, read the same offsets as solved here", () => {
    const editor = rally();
    editor.addInk(InkStroke.make([{ x: -3, z: 2 }, { x: 1, z: 2.5 }]));
    editor.setLabel("7", editor.scene.tokens[2].id);
    const scene = editor.scene;
    const here = studioTrack(scene);
    // As the worker does: the bodies' scene, solved in slices, the moments handed over in batches.
    const there = studioTrack(bodyScene(structuredClone(scene)));
    const copy = new SeparationMoments(0, there.end);
    let sent = 0;
    while (!there.solveFor(5)) {
      const { times, offsets } = there.slice(sent);
      copy.append(sent, times, offsets);
      sent += times.length;
    }
    const { times, offsets } = there.slice(sent);
    copy.append(sent, times, offsets);
    expect(copy.complete).toBe(true);
    for (let s = 0; s <= here.end + 1e-9; s += 1 / 30) {
      expect(copy.covers(s)).toBe(true);
      expect(copy.offsets(s)).toEqual(here.offsets(s));
    }
    expect(copy.solvedCount).toBe(here.solvedCount);
  }, 60000);

  it("a copy covers a moment only once the moments around it have arrived", () => {
    const track = studioTrack(rally().scene);
    track.solveFor(1);
    const copy = new SeparationMoments(0, track.end);
    expect(copy.covers(0)).toBe(false);
    expect(copy.offsets(0).size).toBe(0);
    const { times, offsets } = track.slice(0);
    copy.append(0, times, offsets);
    const last = copy.solvedTo!;
    expect(copy.covers(last - 0.1)).toBe(true);
    expect(copy.covers(last)).toBe(last >= track.end - 1e-9);
  });
});
