// Port of CoachBoardCoreTests/BallTests.swift.
import { describe, expect, it } from "vitest";
import { BallContact } from "../zones/ballPlan";
import { RallyPhase } from "../zones/sceneTimeline";
import { SceneEditor, SceneToken, TacticalScene } from "../zones/tacticalScene";
import { Aero, BallFlight, FlightSolver } from "./ballFlight";
import { V3 } from "./math3d";
import { expectClose } from "./testSupport";

describe("BallTests", () => {
  it("drag deceleration matches the blueprint", () => {
    // rho A / 2m is about 0.077 per metre; a 25 m/s ball with C_D 0.25 decelerates at about 12 m/s^2.
    expectClose(BallFlight.k, 0.077, 0.001);
    const a = BallFlight.acceleration(new V3(25, 0, 0), Aero.float, new V3(0, 0, 1));
    expectClose(-a.x, 12.0, 0.1);
    expectClose(a.y, -9.81, 1e-9);
    // Topspin pushes a forward-moving ball down.
    const axis = BallFlight.spinAxis(new V3(0, 0, -1));
    expect(BallFlight.acceleration(new V3(0, 0, -25), Aero.topspin, axis).y).toBeLessThan(-9.81 - 5);
  });

  it("RK4 matches the vacuum parabola", () => {
    const vacuum = Aero.create(0, 0);
    const samples = BallFlight.simulate(new V3(0, 2, 0), new V3(3, 6, 0), vacuum, (s) => s.t >= 1.0 - 1e-9);
    const end = samples[samples.length - 1];
    expectClose(end.p.x, 3, 1e-9);
    expectClose(end.p.y, 2 + 6 - 0.5 * 9.81, 1e-9);
  });

  it("aimed attack lands on target and clears the net", () => {
    const contact = new V3(0.5, 3.0, 0.6);
    const target = new V3(-2, BallFlight.radius, -6.5);
    const t = FlightSolver.aim(contact, target, 25, Aero.topspin);
    expect(t).toBeDefined();
    expect(t!.end.sub(target).length).toBeLessThan(1e-9);
    // Re-fly the solved launch velocity without the solver: it lands within 3 cm of the target.
    const v0 = t!.samples[0].v;
    const check = BallFlight.simulate(contact, v0, Aero.topspin, (s) => s.p.y <= BallFlight.radius);
    const landed = check[check.length - 1].p;
    expect(Math.hypot(landed.x - target.x, landed.z - target.z)).toBeLessThan(0.03);
    const net = t!.netCrossing(2.43);
    expect(net).toBeDefined();
    expect(net!.clears, `clearance ${net!.clearance}`).toBe(true);
    expectClose(t!.launchSpeed, 25, 1e-6);
    // Out of reach at 4 m/s.
    expect(FlightSolver.aim(contact, new V3(0, BallFlight.radius, -9), 4, Aero.topspin)).toBeUndefined();
  });

  it("lob hits its apex and target", () => {
    const from = new V3(2, 0.75, 5), to = new V3(1.5, 2.1, 0.7);
    const t = FlightSolver.lob(from, to, 2.43 + 2.0, Aero.soft);
    expect(t).toBeDefined();
    expectClose(t!.apex, 4.43, 0.012);
    expect(t!.end.sub(to).length).toBeLessThan(1e-9);
    expect(t!.duration).toBeGreaterThan(1.0);
    expect(t!.duration).toBeLessThan(2.5);
  });

  it("ball plan chains contacts through the timeline", () => {
    const server = SceneToken.create({ side: "opponent", label: "S", role: "S", point: { x: 3, z: -10 } });
    const libero = SceneToken.create({ side: "home", label: "2", role: "L", point: { x: 0, z: 6 } });
    const setter = SceneToken.create({ side: "home", label: "8", role: "S", point: { x: 1.5, z: 0.7 } });
    const hitter = SceneToken.create({ side: "home", label: "12", role: "OH1", point: { x: 4, z: 1 } });
    const scene = TacticalScene.create({ title: "Rally", tokens: [server, libero, setter, hitter] });
    scene.phases = [...RallyPhase.allCases];
    scene.contacts = [BallContact.create("serve", server.id, "floatServe"),
      BallContact.create("receive", libero.id, "pass"),
      BallContact.create("set", setter.id, "highSet"),
      BallContact.create("attack", hitter.id, "attack")];
    const plan = TacticalScene.ballPlan(scene);
    expect(plan.segments.length).toBe(4);
    expect(plan.segments.every((s) => s.trajectory !== undefined)).toBe(true);
    // Each flight ends where the next contact begins, and the ball sits there at the marker.
    for (let k = 0; k < 3; k++) {
      expect(plan.segments[k].trajectory!.end.sub(plan.segments[k + 1].from).length).toBeLessThan(1e-9);
      expect(plan.position(k + 1)!.sub(plan.segments[k + 1].from).length).toBeLessThan(1e-6);
    }
    // The serve crosses the net; the attack lands deep in the far half by default.
    expect(plan.segments[0].trajectory?.netCrossing(2.43)?.clears).toBe(true);
    expectClose(plan.segments[3].to.z, -6, 1e-9);
    expect(plan.segments[3].endTime).toBe(4);
    expect(plan.segments[3].summary(2.43).startsWith("#12 ATTACK · 25 m/s · ")).toBe(true);
    // Mid-way through the set the ball is high above the tape.
    expect(plan.position(2.5)!.y).toBeGreaterThan(3.5);
    // Editor: one contact per marker, undoable.
    const e = new SceneEditor(scene);
    e.setContact(BallContact.create("set", setter.id, "quickSet"), "set");
    expect(e.scene.contacts?.length).toBe(4);
    expect(e.scene.contacts?.find((c) => c.phase === "set")?.kind).toBe("quickSet");
    e.setContact(undefined, "attack");
    expect(e.scene.contacts?.length).toBe(3);
    e.undo();
    e.undo();
    expect(TacticalScene.equals(e.scene, scene)).toBe(true);
  });
});
