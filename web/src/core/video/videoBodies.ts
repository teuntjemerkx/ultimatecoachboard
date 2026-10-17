// Web addition (no Swift counterpart): the players of a rebuilt rally as bodies that never stand in each other or
// reach through the net. Positions read from a video are noisy, and two players close together (a double block, a
// switch, a passer and the libero) easily come out a few centimetres inside each other; this slides them apart.
import type { FloorPoint } from "../match/court";
import { SeparationTrack, separateBodies } from "../spatial/bodySeparation";
import { PlayerBodies, type PosedPlayer } from "../spatial/povAnalysis";
import type { VideoFrame, VideoScene } from "./videoScene";

/** Seconds ahead used to read the players' velocities. */
const lookAhead = 0.05;

/** One track per scene, for the bodies drawn when it was made (women or men, athletes or mannequins). */
const tracks = new WeakMap<VideoScene, { track: SeparationTrack; bodies: string }>();

function velocities(scene: VideoScene, t: number, frame: VideoFrame): Map<string, FloorPoint> {
  const later = Math.min(scene.duration, t + lookAhead);
  const ahead = later > t ? scene.frame(later) : undefined;
  const k = ahead ? 1 / (later - t) : 0;
  return new Map(frame.tokens.map((token) => {
    const a = ahead?.tokens.find((q) => q.id === token.id);
    return [token.id, a ? { x: (a.point.x - token.point.x) * k, z: (a.point.z - token.point.z) * k } : { x: 0, z: 0 }];
  }));
}

/** Players running give way more readily, and so do players the video saw less clearly. */
function weightOf(frame: VideoFrame, velocity: ReadonlyMap<string, FloorPoint>) {
  return (p: PosedPlayer) => {
    const v = velocity.get(p.id);
    const confidence = Math.max(0, Math.min(1, frame.confidence.get(p.id) ?? 1));
    return (0.3 + Math.hypot(v?.x ?? 0, v?.z ?? 0)) * (1.5 - confidence);
  };
}

/**
 * Every player at time t, posed as reconstructed and slid aside as little as their bodies need: along the rally (one
 * SeparationTrack per scene, so players step around each other rather than jump) and, for this exact moment, any
 * touch left. Players taking steps are kept apart by their whole step cycle (PosedPlayer.strideEnvelope), so the
 * swinging arms and legs never reach into anyone. Use it wherever the rally is shown or analysed in 3D.
 */
export function videoBodies(scene: VideoScene, t: number): PosedPlayer[] {
  const bodies = `${PlayerBodies.women}|${PlayerBodies.athletes}`;
  let entry = tracks.get(scene);
  if (!entry || entry.bodies !== bodies) {
    const track = new SeparationTrack((time) => {
      const f = scene.frame(time);
      const velocity = velocities(scene, time, f);
      return { players: f.posedPlayers(), velocity, weight: weightOf(f, velocity) };
    }, 0, Math.max(0, scene.duration), { floor: (time) => new Map(scene.frame(time).tokens.map((t) => [t.id, t.point])) });
    entry?.track.stop();
    track.prepare();
    entry = { track, bodies };
    tracks.set(scene, entry);
  }
  const track = entry.track;
  const frame = scene.frame(t);
  const velocity = velocities(scene, t, frame);
  return separateBodies(frame.posedPlayers(), { weight: weightOf(frame, velocity), velocity: (p) => velocity.get(p.id) },
    track.offsets(t));
}
