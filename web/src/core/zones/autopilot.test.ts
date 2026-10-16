// Port of CoachBoardCoreTests/AutopilotTests.swift.
import { describe, expect, it } from "vitest";
import { CourtFrame } from "../match/court";
import { TemplateLibrary } from "../match/rotationTemplate";
import { PlayerBodies, defaultStature } from "../spatial/povAnalysis";
import { expectClose } from "../spatial/testSupport";
import { AttackOption, PlacementAssist, SceneSetup, nextRotation, previousRotation, templateRotations } from "./sceneAutopilot";
import { RallyPhase } from "./sceneTimeline";
import { SceneEditor, SceneToken, TacticalScene } from "./tacticalScene";

/** Swift `TeamSystem.allCases` (raw values, which are the template ids). */
const teamSystems = ["5-1-outside-follows-setter", "5-1-middle-follows-setter", "6-2", "4-2", "youth-w"];

describe("AutopilotTests", () => {
  it("places both teams from a setup", () => {
    const scene = TacticalScene.placed("R1", SceneSetup.create());
    expect(scene.tokens.filter((t) => t.side === "home").length).toBe(6);
    expect(scene.tokens.filter((t) => t.side === "opponent").length).toBe(6);
    // The opponent serves: its P1 stands behind the end line on its half.
    const server = scene.tokens.find((t) => Math.abs(t.point.z) > 9);
    expect(server?.side).toBe("opponent");
    expect(server?.point.z ?? 0).toBeLessThan(-9);
    // Home receives in R1 with the libero on court.
    expect(scene.tokens.some((t) => t.side === "home" && t.role === "L")).toBe(true);
    expect(scene.tokens.every((t) => (t.side === "home" ? t.point.z > 0 : t.point.z < 0))).toBe(true);
  });

  it("rotate keeps identity and labels", () => {
    let scene = TacticalScene.placed("R1", SceneSetup.create());
    const i = scene.tokens.findIndex((t) => t.side === "home" && t.role === "OH1");
    scene.tokens[i].label = "7";
    const id = scene.tokens[i].id;
    scene = TacticalScene.rotate(scene, "home");
    expect(scene.setup?.homeRotation).toBe(6);
    const oh1 = scene.tokens.find((t) => t.side === "home" && t.role === "OH1");
    expect(oh1?.id).toBe(id);
    expect(oh1?.label).toBe("7");
    // Six rotations bring the team back to R1.
    for (let n = 0; n < 5; n++) scene = TacticalScene.rotate(scene, "home");
    expect(scene.setup?.homeRotation).toBe(1);
    expect(scene.tokens.find((t) => t.id === id)?.label).toBe("7");
  });

  it("rotation cycles", () => {
    const sixTwo = TemplateLibrary.template("6-2");
    expect(nextRotation(sixTwo, 1)).toBe(6);
    expect(nextRotation(sixTwo, 5)).toBe(1);
    const fourTwo = TemplateLibrary.template("4-2");
    expect(nextRotation(fourTwo, 4)).toBe(3);
    expect(nextRotation(fourTwo, 2)).toBe(4);
    expect(previousRotation(fourTwo, 4)).toBe(2);
    const youth = TemplateLibrary.template("youth-w");
    expect(nextRotation(youth, 0)).toBe(0);
  });

  it("every system places six and six", () => {
    for (const system of teamSystems) {
      let t;
      try {
        t = TemplateLibrary.template(system);
      } catch {
        t = undefined;
      }
      const r = (t ? templateRotations(t)[0] : undefined) ?? 1;
      for (const serves of [false, true]) {
        const setup = SceneSetup.create({ homeSystem: system, homeRotation: r, homeServes: serves });
        const scene = TacticalScene.placed(system, setup);
        expect(scene.tokens.filter((tok) => tok.side === "home").length, `${system} serves ${serves}`).toBe(6);
        expect(scene.tokens.filter((tok) => tok.side === "opponent").length).toBe(6);
      }
    }
  });

  it("play out builds a rally", () => {
    for (const attack of AttackOption.allCases) {
      for (const homeServes of [false, true]) {
        let scene = TacticalScene.placed("rally", SceneSetup.create({ homeServes }));
        scene = TacticalScene.playOut(scene, attack);
        expect(TacticalScene.timeline(scene)).toEqual(RallyPhase.allCases);
        expect(scene.contacts?.map((c) => c.phase), attack).toEqual(["serve", "receive", "set", "attack", "cover"]);
        const plan = TacticalScene.ballPlan(scene);
        expect(plan.segments.length).toBe(5);
        expect(plan.segments.every((s) => s.trajectory !== undefined), `${attack} ${homeServes}`).toBe(true);
        // The serve and the attack cross the net above the tape.
        for (const k of [0, 3]) {
          const crossing = plan.segments[k].trajectory?.netCrossing(2.43);
          expect(crossing, `${attack} segment ${k}`).toBeDefined();
          expect(crossing?.clears ?? false, `${attack} ${homeServes} segment ${k}: ${JSON.stringify(crossing)}`).toBe(true);
        }
        // Players stay on their own side at every marker and never stand inside each other.
        for (let m = 0; m < 6; m++) {
          const f = TacticalScene.frame(scene, m);
          for (const t of f.tokens) expect(t.side === "home" ? t.point.z > 0 : t.point.z < 0, `${t.role} at ${m}`).toBe(true);
          for (const side of ["home", "opponent"] as const) {
            const pts = f.tokens.filter((t) => t.side === side).map((t) => t.point);
            for (let a = 0; a < pts.length; a++) {
              for (let b = a + 1; b < pts.length; b++) {
                expect(Math.hypot(pts[a].x - pts[b].x, pts[a].z - pts[b].z), `${attack} marker ${m}`).toBeGreaterThan(0.3);
              }
            }
          }
        }
      }
    }
  });

  it("women's rally clears the lower net", () => {
    PlayerBodies.women = true;
    try {
      expect(PlayerBodies.netHeight).toBe(2.24);
      expectClose(defaultStature("MB1"), 1.9, 1e-9);
      expectClose(SceneToken.defaultStature("MB1"), 1.9, 1e-9);
      for (const attack of AttackOption.allCases) {
        const scene = TacticalScene.playOut(TacticalScene.placed("women", SceneSetup.create()), attack);
        const plan = TacticalScene.ballPlan(scene, PlayerBodies.netHeight);
        for (const k of [0, 3]) {
          const crossing = plan.segments[k].trajectory?.netCrossing(PlayerBodies.netHeight);
          expect(crossing?.clears ?? false, `${attack} segment ${k}: ${JSON.stringify(crossing)}`).toBe(true);
        }
      }
    } finally {
      PlayerBodies.women = false;
    }
  });

  it("players face the ball", () => {
    const scene = TacticalScene.playOut(TacticalScene.placed("rally", SceneSetup.create()), "left");
    const plan = TacticalScene.ballPlan(scene);
    const t = 0.5;
    const ball = plan.position(t)!;
    const f = TacticalScene.liveFrame(scene, t, plan);
    for (const token of f.tokens.filter((tok) => tok.side === "home")) {
      const want = Math.atan2(ball.x - token.point.x, ball.z - token.point.z);
      let d = Math.abs((SceneToken.facing(token) - want) % (2 * Math.PI));
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d, token.role).toBeLessThan(0.05);
    }
    // Without a ball the receivers face the server.
    const still = TacticalScene.liveFrame(TacticalScene.placed("still", SceneSetup.create()), 0);
    const server = still.tokens.find((tok) => Math.abs(tok.point.z) > 9)!;
    const receiver = still.tokens.find((tok) => tok.side === "home")!;
    expectClose(SceneToken.facing(receiver), Math.atan2(server.point.x - receiver.point.x, server.point.z - receiver.point.z), 1e-9);
    // An explicit facing wins.
    const turned = { ...scene, tokens: scene.tokens.map((tok, i) => (i === 0 ? { ...tok, yaw: 1.0 } : tok)) };
    expect(SceneToken.facing(TacticalScene.liveFrame(turned, t, plan).tokens[0])).toBe(1.0);
  });

  it("placement assist snaps and separates", () => {
    const scene = TacticalScene.placed("snap", SceneSetup.create());
    const spots = PlacementAssist.spots("home", scene.setup);
    expect(spots.length).toBeGreaterThan(0);
    const base = CourtFrame.world({ l: 4.5, d: 8.0 }, "home");
    const mover = scene.tokens.find((t) => t.side === "home")!;
    const others = scene.tokens.filter((t) => t.id !== mover.id && Math.hypot(t.point.x - base.x, t.point.z - base.z) > 1);
    const r = PlacementAssist.adjust({ x: base.x + 0.2, z: base.z - 0.1 }, mover.id, "home", others, spots);
    expect(r.snapped).toEqual(base);
    // Dropped on top of a teammate: nudged out to the minimum separation.
    const mate = scene.tokens.find((t) => t.side === "home" && t.id !== mover.id)!;
    const pushed = PlacementAssist.adjust({ x: mate.point.x + 0.1, z: mate.point.z }, mover.id, "home", [mate], []);
    expect(Math.hypot(pushed.point.x - mate.point.x, pushed.point.z - mate.point.z)).toBeGreaterThanOrEqual(PlacementAssist.minSeparation - 1e-9);
  });

  it("scene with setup round-trips and old files still load", () => {
    const scene = TacticalScene.placed("codable", SceneSetup.create({ homeRotation: 4, homeServes: true, attack: "back" }));
    scene.tokens[0].yaw = 0.5;
    const data = JSON.stringify(TacticalScene.encode(scene));
    const back = TacticalScene.decode(data);
    expect(TacticalScene.equals(back, scene)).toBe(true);
    const old = TacticalScene.create({ title: "old" });
    old.tokens = [SceneToken.create({ side: "home", label: "1", role: "S", point: { x: 0, z: 3 } })];
    const json = JSON.parse(JSON.stringify(TacticalScene.encode(old)));
    delete json.setup;
    const decoded = TacticalScene.decode(JSON.stringify(json));
    expect(decoded.setup).toBeUndefined();
    expect(decoded.tokens[0].yaw).toBeUndefined();
  });

  it("editor autopilot is one undo step", () => {
    const editor = new SceneEditor(TacticalScene.placed("undo", SceneSetup.create()));
    const before = editor.scene;
    editor.playOut("middle");
    expect(TacticalScene.timeline(editor.scene).length).toBe(6);
    editor.undo();
    expect(TacticalScene.equals(editor.scene, before)).toBe(true);
    editor.rotate("home");
    expect(editor.scene.setup?.homeRotation).toBe(6);
  });
});
