// The heavy part of Video to 3D off the main thread: the clean plate (temporal median of the sampled frames) and the
// reconstruction (tracking, pose fitting, the ball), so the progress bar keeps moving.
import { PlayerBodies, defaultStature } from "../../core/spatial";
import {
  CleanPlate, VideoCamera, VideoReconstructor, type TrackLock, type VideoCameraJSON, type VideoFrameObservation, type VideoSceneJSON,
} from "../../core/video";
import { RallyTracker } from "./rallyTracker";

export type RebuildRequest =
  | { kind: "plate"; frames: Uint8Array[]; masks: Uint8Array[]; width: number; height: number }
  | { kind: "reconstruct"; frames: VideoFrameObservation[]; camera: VideoCameraJSON; netHeight: number; women: boolean; title: string;
      /** The players the coach tapped, followed through the whole clip. */
      locks?: TrackLock[] };

export type RebuildReply =
  | { kind: "plate"; pixels: Uint8Array }
  | { kind: "progress"; fraction: number; stage: string }
  | { kind: "scene"; scene: VideoSceneJSON }
  | { kind: "error"; message: string };

/** The worker's global scope (typed by hand: the project compiles against the DOM library). */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<RebuildRequest>) => void) | null;
  postMessage(message: RebuildReply, transfer: Transferable[]): void;
};

scope.onmessage = (e: MessageEvent<RebuildRequest>) => {
  const msg = e.data;
  const reply = (r: RebuildReply, transfer: Transferable[] = []) => scope.postMessage(r, transfer);
  try {
    if (msg.kind === "plate") {
      const pixels = CleanPlate.median(msg.frames, msg.masks, msg.width, msg.height);
      reply({ kind: "plate", pixels }, [pixels.buffer]);
    } else {
      PlayerBodies.women = msg.women;
      const camera = VideoCamera.decode(msg.camera);
      const scene = VideoReconstructor.reconstruct(msg.frames, camera, {
        netHeight: msg.netHeight, title: msg.title, tracker: RallyTracker.forCamera(camera, msg.locks),
        progress: (fraction, stage) => reply({ kind: "progress", fraction, stage }),
      });
      // The statures the poses were fitted with (women or men), kept with the scene so it shows the same anywhere.
      for (const p of scene.players) p.stature ??= defaultStature(p.role);
      reply({ kind: "scene", scene: scene.encode() });
    }
  } catch (err) {
    reply({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
