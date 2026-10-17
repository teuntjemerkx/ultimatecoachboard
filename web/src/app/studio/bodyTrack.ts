// How the Studio keeps its players' bodies apart through a rally (see studioBodies in studio.ts). This module holds no
// app state, so the bodies worker (bodies.worker.ts) builds exactly the same track as the page would.
import type { FloorPoint } from "../../core/match/court";
import { PlayerBodies, SeparationTrack, posedPlayers } from "../../core/spatial";
import { TacticalScene, sceneClock, sceneFrame, sceneMotion, type BallPlan } from "../../core/zones";

/** Floor velocities (m/s) of a scene's players at a timeline position, as the scene plays (sceneMotion). */
export function velocities(scene: TacticalScene, time: number): Map<string, FloorPoint> {
  return new Map([...sceneMotion(scene, time)].map(([id, m]) => [id, m.velocity]));
}

/**
 * The rally's separation track, in seconds as the scene plays (sceneClock): every moment posed, players taking steps,
 * those running giving way more readily than those standing.
 */
export function studioTrack(scene: TacticalScene, plan: BallPlan = TacticalScene.ballPlan(scene, PlayerBodies.netHeight)): SeparationTrack {
  const clock = sceneClock(scene);
  return new SeparationTrack((seconds) => {
    const t = clock.time(seconds);
    const f = TacticalScene.liveFrame(scene, t, plan);
    const velocity = velocities(scene, t);
    return { players: posedPlayers(f), velocity, weight: (p) => 0.3 + Math.hypot(velocity.get(p.id)!.x, velocity.get(p.id)!.z) };
  }, 0, clock.total, {
    floor: (seconds) => new Map(sceneFrame(scene, clock.time(seconds)).tokens.map((t) => [t.id, t.point])),
  });
}

/**
 * What of a scene its bodies depend on: the players (without their names), the timeline, the ball and the setup. Not
 * the title, names, zones or ink, so drawing or renaming never solves the rally again.
 */
export function bodyScene(scene: TacticalScene): TacticalScene {
  return {
    id: "", title: "", createdAt: 0, modifiedAt: 0, zones: [], ink: [],
    tokens: scene.tokens.map((t) => ({ ...t, label: "" })),
    phases: scene.phases, contacts: scene.contacts, ballLanding: scene.ballLanding, ballLandingHeight: scene.ballLandingHeight,
    setup: scene.setup && { ...scene.setup, labels: {} },
  };
}

const keys = new WeakMap<TacticalScene, string>();

/** Changes exactly when the scene's bodies may (see bodyScene), or the body settings (women or men, athletes). */
export function bodyKey(scene: TacticalScene): string {
  let key = keys.get(scene);
  if (key === undefined) {
    key = JSON.stringify(bodyScene(scene));
    keys.set(scene, key);
  }
  return `${PlayerBodies.women}|${PlayerBodies.athletes}|${key}`;
}
