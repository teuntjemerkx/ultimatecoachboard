// Web addition (no Swift counterpart): how fast and which way each rebuilt player moves over the floor, and how far
// through the step cycle (spatial/gait.ts) they are, for `VideoFrame.posedPlayers`. The velocity is read from the
// path over 0.2 s either side, which steadies the jitter of single detections; the cycle advances with the distance
// covered, so the 3D player takes steps as long and as quick as the video's player covers ground.
import type { FloorPoint } from "../match/court";
import { Stride } from "../spatial/gait";
import type { VideoPlayerTrack } from "./videoScene";

/** A player's motion at one moment: velocity on the floor (m/s, world x and z) and step phase (radians). */
export interface PlayerMotion {
  velocity: FloorPoint;
  phase: number;
}

const rate = 30;
const halfWindow = 0.2;

interface Timeline {
  t0: number;
  vx: Float64Array;
  vz: Float64Array;
  phase: Float64Array;
}

const timelines = new WeakMap<VideoPlayerTrack, Timeline>();

/** The track's position at time t, between its samples (clamped to its first and last). */
function positionAt(track: VideoPlayerTrack, t: number): FloorPoint {
  const s = track.samples;
  if (t <= s[0].time) return { x: s[0].x, z: s[0].z };
  const last = s[s.length - 1];
  if (t >= last.time) return { x: last.x, z: last.z };
  let i = 0, j = s.length - 1;
  while (j - i > 1) {
    const m = (i + j) >> 1;
    if (s[m].time <= t) i = m;
    else j = m;
  }
  const a = s[i], b = s[j];
  const u = b.time > a.time ? (t - a.time) / (b.time - a.time) : 0;
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
}

function timeline(track: VideoPlayerTrack): Timeline {
  const cached = timelines.get(track);
  if (cached) return cached;
  const s = track.samples;
  const t0 = s[0].time, t1 = s[s.length - 1].time;
  const n = Math.max(1, Math.ceil((t1 - t0) * rate) + 1);
  const vx = new Float64Array(n), vz = new Float64Array(n), phase = new Float64Array(n);
  let speedBefore = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k / rate;
    const a = Math.max(t0, t - halfWindow), b = Math.min(t1, t + halfWindow);
    if (b > a) {
      const p = positionAt(track, a), q = positionAt(track, b);
      let x = (q.x - p.x) / (b - a), z = (q.z - p.z) / (b - a);
      const speed = Math.hypot(x, z);
      if (speed > Stride.maxSpeed) {
        x *= Stride.maxSpeed / speed;
        z *= Stride.maxSpeed / speed;
      }
      vx[k] = x;
      vz[k] = z;
    }
    const speed = Math.hypot(vx[k], vz[k]);
    if (k > 0) {
      const mean = (speed + speedBefore) / 2;
      phase[k] = phase[k - 1] + (mean / rate) * Stride.phasePerMetre(mean);
    }
    speedBefore = speed;
  }
  const out = { t0, vx, vz, phase };
  timelines.set(track, out);
  return out;
}

/** The player's motion at time t (undefined outside the track or for a track without samples). */
export function motionAt(track: VideoPlayerTrack, t: number): PlayerMotion | undefined {
  if (track.samples.length === 0) return undefined;
  const tl = timeline(track);
  const x = (t - tl.t0) * rate;
  const n = tl.phase.length;
  if (!(x >= -1e-6 && x <= n - 1 + 1e-6)) return undefined;
  const k = Math.max(0, Math.min(n - 1, Math.floor(x))), k1 = Math.min(n - 1, k + 1), u = Math.max(0, Math.min(1, x - k));
  return {
    velocity: { x: tl.vx[k] + (tl.vx[k1] - tl.vx[k]) * u, z: tl.vz[k] + (tl.vz[k1] - tl.vz[k]) * u },
    phase: tl.phase[k] + (tl.phase[k1] - tl.phase[k]) * u,
  };
}
