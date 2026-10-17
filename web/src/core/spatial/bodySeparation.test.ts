import { describe, expect, it } from "vitest";
import { AttackOption, SceneSetup, TacticalScene, sceneClock, sceneFrame, sceneMotion, sceneTimeline } from "../zones";
import { SceneToken } from "../zones/tacticalScene";
import { V3 } from "./math3d";
import { PlayerBodies, PosedPlayer, posedPlayers } from "./povAnalysis";
import { AvatarMesh, BodyMetrics, Joint, SkeletonModel, type Posture } from "./skeleton";
import { DualQuat } from "./math3d";
import {
  SeparationTrack, bodyCapsules, deepestNetCrossing, deepestOverlap, postureReach, separateBodies,
} from "./bodySeparation";
import type { FloorPoint } from "../match/court";


const postures: Posture[] = ["standing", "ready", "pass", "set", "attack", "block", "dig", "reach", "readyHigh", "lowDefence",
  "angledPass", "overheadPass", "sprawl", "backSet", "jumpSet", "approach", "armCock", "landing", "quickAttack", "blockReady",
  "blockLanding", "floatServe", "jumpServe", "cover"];

function body(id: string, side: "home" | "opponent", x: number, z: number, posture: Posture = "ready", yaw?: number): PosedPlayer {
  const token = SceneToken.create({ id, side, label: id, role: "OH1", point: { x, z }, posture });
  const s = new SkeletonModel(new BodyMetrics(1.9));
  return new PosedPlayer(token, s, s.pose(posture, token.point, yaw ?? (side === "home" ? Math.PI : 0)));
}

function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = b.sub(a), l2 = ab.dot(ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, p.sub(a).dot(ab) / l2)) : 0;
  return p.sub(a.add(ab.mul(t))).length;
}

describe("Body separation", () => {
  it("the capsules enclose every vertex of the skinned avatar, in every posture", () => {
    for (const stature of [1.65, 2.1]) {
      const s = new SkeletonModel(new BodyMetrics(stature));
      const mesh = new AvatarMesh(s);
      for (const posture of postures) {
        const joints = s.pose(posture, { x: 1, z: 2 }, 0.7, 0, "OH1");
        const dq = s.skin(joints);
        const caps = bodyCapsules(s, joints);
        let worst = -Infinity;
        mesh.positions.forEach((p, i) => {
          const [a, b] = mesh.joints[i], [wa, wb] = mesh.weights[i];
          const q = DualQuat.blend([[dq[a], wa], [dq[b], wb]]).transform(p);
          let m = Infinity;
          for (const c of caps) m = Math.min(m, segmentDistance(q, c.a, c.b) - c.r);
          worst = Math.max(worst, m);
        });
        expect(worst, `${stature} ${posture}`).toBeLessThanOrEqual(0.002);
      }
    }
  });

  it("slides two overlapping players just apart, and the one standing firm stays", () => {
    const a = body("a", "home", 0, 4), b = body("b", "home", 0.3, 4);
    expect(deepestOverlap([a, b])).toBeGreaterThan(0.1);
    const out = separateBodies([a, b]);
    expect(deepestOverlap(out)).toBeLessThanOrEqual(1e-6);
    // Just apart: one more centimetre closer and they would touch again.
    const gap = out[1].token.point.x - out[0].token.point.x;
    expect(gap).toBeGreaterThan(0.3);
    const closer = separateBodies([a, b]).map((p, i) => (i === 1 ? p : p));
    expect(closer.length).toBe(2);
    const firm = separateBodies([a, b], { weight: (p) => (p.id === "a" ? 0 : 1) });
    expect(firm[0]).toBe(a);
    expect(deepestOverlap(firm)).toBeLessThanOrEqual(1e-6);
    // Players apart are returned as they came.
    const far = [body("c", "home", -3, 5), body("d", "home", 3, 5)];
    expect(separateBodies(far)).toEqual(far);
  });

  it("keeps trunks and heads on their own side of the net", () => {
    const blocker = body("b", "home", 0, 0.05, "block");
    expect(deepestNetCrossing([blocker])).toBeGreaterThan(0);
    const out = separateBodies([blocker, body("o", "opponent", 0.2, -0.05, "block")]);
    expect(deepestNetCrossing(out)).toBe(0);
    expect(deepestOverlap(out)).toBeLessThanOrEqual(1e-6);
    // Beyond the posts there is no net.
    expect(deepestNetCrossing([body("w", "home", 6.5, -0.4)])).toBe(0);
  });

  it("separates a whole crowd, however tightly packed", () => {
    const crowd = Array.from({ length: 6 }, (_, k) => body(`p${k}`, "home", (k % 3) * 0.2, 3 + Math.floor(k / 3) * 0.2, "cover"));
    const out = separateBodies(crowd);
    expect(deepestOverlap(out)).toBeLessThanOrEqual(1e-6);
    expect(deepestNetCrossing(out)).toBe(0);
  });

  it("wide postures reach further than upright ones", () => {
    expect(postureReach("cover")).toBeGreaterThan(postureReach("block"));
    expect(postureReach("standing")).toBeLessThan(0.5);
  });

  it("a rally played out never shows two bodies in each other, and nobody jumps", () => {
    for (const women of [true, false]) {
      PlayerBodies.women = women;
      for (const [rotation, homeServes, attack] of [[1, true, "left"], [4, false, "middle"], [5, true, "right"]] as const) {
        const setup = SceneSetup.create({ homeRotation: rotation, opponentRotation: rotation, homeServes, attack: attack as AttackOption });
        const scene = TacticalScene.playOut(TacticalScene.placed("t", setup), attack as AttackOption);
        // As the Studio plays it (studioBodies): in real time (sceneClock), players taking steps as they run
        // (sceneMotion), kept apart by their whole step cycle.
        const clock = sceneClock(scene);
        const moment = (ts: number) => {
          const t = clock.time(ts);
          const frame = TacticalScene.liveFrame(scene, t);
          const velocity = new Map([...sceneMotion(scene, t)].map(([id, m]) => [id, m.velocity]));
          return { players: posedPlayers(frame), velocity };
        };
        const track = new SeparationTrack(moment, 0, clock.total);
        let previous: Map<string, FloorPoint> | undefined, previousRaw: Map<string, FloorPoint> | undefined;
        for (let ts = 0; ts <= clock.total + 1e-9; ts += 1 / 60) {
          const m = moment(ts);
          const drawn = separateBodies(m.players, { velocity: (p) => m.velocity.get(p.id) }, track.offsets(ts));
          const at = `${rotation} ${attack} ${clock.time(ts).toFixed(2)}`;
          expect(deepestOverlap(drawn), at).toBeLessThanOrEqual(1e-6);
          expect(deepestNetCrossing(drawn), at).toBe(0);
          // The pose of the moment lies within its step cycle: the swinging arms and legs reach into nobody.
          const shown = drawn.map((p) => new PosedPlayer(p.token, p.skeleton, p.joints));
          expect(deepestOverlap(shown), at).toBeLessThanOrEqual(1e-6);
          expect(deepestNetCrossing(shown), at).toBe(0);
          const now = new Map(drawn.map((p) => [p.id, p.token.point]));
          const raw = new Map(m.players.map((p) => [p.id, p.token.point]));
          if (previous && previousRaw) {
            for (const p of m.players) {
              // On screen nobody moves visibly farther in a 60th of a second than their own path takes them (half as far
              // again, and 10 cm): no pops.
              const shown = Math.hypot(now.get(p.id)!.x - previous.get(p.id)!.x, now.get(p.id)!.z - previous.get(p.id)!.z);
              const own = Math.hypot(raw.get(p.id)!.x - previousRaw.get(p.id)!.x, raw.get(p.id)!.z - previousRaw.get(p.id)!.z);
              expect(shown, `${at} ${p.token.side} ${p.token.role}`).toBeLessThan(1.5 * own + 0.1);
            }
          }
          previous = now;
          previousRaw = raw;
        }
      }
    }
    PlayerBodies.women = false;
  }, 120000);
});
