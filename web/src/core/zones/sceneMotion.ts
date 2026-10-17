// Web addition (no Swift counterpart): how a scene plays in time, and how each player moves over the floor while it
// does. A phase (one marker to the next) takes 1.1 s, longer when a player has farther to run than a sprint covers in
// that time, so nobody crosses the court faster than a person can. Each player's velocity and place in the step cycle
// (spatial/gait.ts) are read from the scene's own paths at fine steps, once per scene: a player running to a new spot
// takes steps instead of sliding over the court in one stance, and the cycle advances with the distance covered, so a
// planted foot stays where it is while the body passes it.
import type { FloorPoint } from "../match/court";
import { Stride } from "../spatial/gait";
import { sceneFrame, sceneTimeline } from "./sceneTimeline";
import type { TacticalScene } from "./tacticalScene";

/** Seconds a phase (one marker to the next) takes at least when a scene plays. */
export const secondsPerPhase = 1.1;

/**
 * The average speed of the longest run in a phase at most, m/s: players speed up and slow down smoothly
 * (Timeline.stride), peaking at 1.5 times this, about 6.8 m/s, a sprint.
 */
const sprint = 4.5;

/** A player's motion at one moment: velocity on the floor (m/s, world x and z) and step phase (radians). */
export interface SceneMotion {
  velocity: FloorPoint;
  phase: number;
}

/** When a scene's moments play: timeline positions (phase-index units) and seconds from the first marker. */
export interface SceneClock {
  /** Seconds each phase takes, first marker on. */
  durations: number[];
  /** Seconds the whole timeline takes. */
  total: number;
  /** Seconds from the first marker to a timeline position. */
  seconds(time: number): number;
  /** The timeline position at a number of seconds from the first marker. */
  time(seconds: number): number;
}

/** Samples per phase of the timeline. */
const rate = 30;

interface Played {
  clock: SceneClock;
  motion: Map<string, { vx: Float64Array; vz: Float64Array; phase: Float64Array }>;
}

const played = new WeakMap<TacticalScene, Played>();

function playedOf(scene: TacticalScene): Played {
  const cached = played.get(scene);
  if (cached) return cached;
  const end = Math.max(0, sceneTimeline(scene).length - 1);
  const n = Math.round(end * rate) + 1;
  // Every player's place at every sample.
  const ids = scene.tokens.map((t) => t.id);
  const xs = ids.map(() => new Float64Array(n)), zs = ids.map(() => new Float64Array(n));
  for (let k = 0; k < n; k++) {
    const byId = new Map(sceneFrame(scene, Math.min(end, k / rate)).tokens.map((t) => [t.id, t.point]));
    ids.forEach((id, i) => {
      const p = byId.get(id)!;
      xs[i][k] = p.x;
      zs[i][k] = p.z;
    });
  }
  // How long each phase takes: long enough for its longest run.
  const durations: number[] = [];
  for (let phase = 0; phase < end; phase++) {
    let longest = 0;
    for (let i = 0; i < ids.length; i++) {
      let run = 0;
      for (let k = phase * rate; k < (phase + 1) * rate; k++) run += Math.hypot(xs[i][k + 1] - xs[i][k], zs[i][k + 1] - zs[i][k]);
      longest = Math.max(longest, run);
    }
    durations.push(Math.max(secondsPerPhase, longest / sprint));
  }
  const starts = [0];
  for (const d of durations) starts.push(starts[starts.length - 1] + d);
  const total = starts[starts.length - 1];
  const clock: SceneClock = {
    durations,
    total,
    seconds(time) {
      const t = Math.max(0, Math.min(end, time));
      const i = Math.min(Math.max(0, end - 1), Math.floor(t));
      return end === 0 ? 0 : starts[i] + (t - i) * durations[i];
    },
    time(seconds) {
      const s = Math.max(0, Math.min(total, seconds));
      let i = 0;
      while (i + 1 < durations.length && starts[i + 1] <= s) i++;
      return end === 0 ? 0 : i + (s - starts[i]) / durations[i];
    },
  };
  // Velocity from the neighbouring samples; the step cycle from the distance covered.
  const motion = new Map<string, { vx: Float64Array; vz: Float64Array; phase: Float64Array }>();
  ids.forEach((id, i) => {
    const vx = new Float64Array(n), vz = new Float64Array(n), phase = new Float64Array(n);
    const sampleSeconds = (k: number) => clock.seconds(k / rate);
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
      const dt = sampleSeconds(b) - sampleSeconds(a);
      if (dt > 0) {
        vx[k] = (xs[i][b] - xs[i][a]) / dt;
        vz[k] = (zs[i][b] - zs[i][a]) / dt;
      }
      if (k > 0) {
        const step = Math.hypot(xs[i][k] - xs[i][k - 1], zs[i][k] - zs[i][k - 1]);
        const mean = (Math.hypot(vx[k], vz[k]) + Math.hypot(vx[k - 1], vz[k - 1])) / 2;
        phase[k] = phase[k - 1] + step * Stride.phasePerMetre(mean);
      }
    }
    motion.set(id, { vx, vz, phase });
  });
  const out = { clock, motion };
  played.set(scene, out);
  return out;
}

/** When a scene's moments play (see SceneClock). */
export function sceneClock(scene: TacticalScene): SceneClock {
  return playedOf(scene).clock;
}

/** Every player's motion at a timeline position (phase-index units); standing still before the first marker and after the last. */
export function sceneMotion(scene: TacticalScene, time: number): Map<string, SceneMotion> {
  const out = new Map<string, SceneMotion>();
  for (const [id, track] of playedOf(scene).motion) {
    const n = track.phase.length;
    const x = Math.max(0, Math.min(n - 1, time * rate));
    const k = Math.min(n - 1, Math.floor(x)), k1 = Math.min(n - 1, k + 1), u = x - k;
    const still = time <= 0 || time * rate >= n - 1;
    out.set(id, {
      velocity: still ? { x: 0, z: 0 } : { x: track.vx[k] + (track.vx[k1] - track.vx[k]) * u, z: track.vz[k] + (track.vz[k1] - track.vz[k]) * u },
      phase: track.phase[k] + (track.phase[k1] - track.phase[k]) * u,
    });
  }
  return out;
}
