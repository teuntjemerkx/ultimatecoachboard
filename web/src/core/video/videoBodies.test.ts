import { describe, expect, it } from "vitest";
import { deepestNetCrossing, deepestOverlap } from "../spatial/bodySeparation";
import { Joint } from "../spatial/skeleton";
import { strideThrough } from "../spatial/testSupport";
import { PersonDetection, PlayerTracker, type VideoFrameObservation } from "./playerTracking";
import { SplitMix64, Synth, uniform } from "./testSupport";
import { videoBodies } from "./videoBodies";
import { VideoPlayerSample, VideoPlayerTrack, VideoScene } from "./videoScene";

describe("Video bodies", () => {
  it("one person detected twice becomes one track, and no real player is dropped for it", () => {
    const rng = new SplitMix64(41);
    const spots = Array.from({ length: 6 }, (_, i) => ({ x: -3.5 + (i % 3) * 3.5, z: i < 3 ? 1.5 : 6 }));
    const frames: VideoFrameObservation[] = strideThrough(0, 3, 1 / 15).map((t, k) => {
      const dets = spots.map((p, i) => PersonDetection.create(
        { x: p.x + 0.3 * Math.sin(t + i) + uniform(rng, -0.05, 0.05), z: p.z + uniform(rng, -0.05, 0.05) }, { x: 0, y: 0 }));
      // Player 5 is missed now and then, so the twin would outlast a real player under the six-per-side cap.
      if (k % 4 === 1) dets.splice(5, 1);
      // Player 0 also comes out a second time, 0.42 m off (a second box on the same person).
      const twin = dets[0].floor;
      dets.push(PersonDetection.create({ x: twin.x + 0.42, z: twin.z + uniform(rng, -0.03, 0.03) }, { x: 0, y: 0 }));
      return { time: t, detections: dets };
    });
    const tracks = new PlayerTracker().track(frames);
    expect(tracks.length).toBe(6);
    // Every real player keeps exactly one track.
    const owners = tracks.map((tr) => {
      const mid = tr.samples[Math.floor(tr.samples.length / 2)];
      return spots.findIndex((p) => Math.hypot(p.x - mid.floor.x, p.z - mid.floor.z) < 0.8);
    });
    expect(new Set(owners)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it("two players whose rebuilt paths run through each other step around each other instead", () => {
    const samples = (from: number, to: number, z: number) => strideThrough(0, 2, 0.1).map((t) =>
      VideoPlayerSample.create(t, from + ((to - from) * t) / 2, z, from < to ? Math.PI / 2 : -Math.PI / 2, "ready"));
    const scene = new VideoScene({
      title: "crossing", duration: 2, camera: Synth.stands, netHeight: 2.24,
      players: [
        VideoPlayerTrack.create({ id: "a", side: "home", label: "1", samples: samples(-3, 3, 4) }),
        VideoPlayerTrack.create({ id: "b", side: "home", label: "2", samples: samples(3, -3, 4.05) }),
        VideoPlayerTrack.create({ id: "c", side: "opponent", label: "3", samples: samples(0, 0.1, -0.2) }),
      ],
    });
    expect(deepestOverlap(scene.frame(1).posedPlayers())).toBeGreaterThan(0.2);
    let previous: Map<string, { x: number; z: number }> | undefined;
    for (const t of strideThrough(0, 2, 1 / 60)) {
      const bodies = videoBodies(scene, t);
      expect(deepestOverlap(bodies), `t ${t.toFixed(3)}`).toBeLessThanOrEqual(1e-6);
      expect(deepestNetCrossing(bodies), `t ${t.toFixed(3)}`).toBe(0);
      const now = new Map(bodies.map((p) => [p.id, p.joints[Joint.pelvis].translation.floor]));
      if (previous) {
        for (const [id, p] of now) {
          const q = previous.get(id)!;
          // 3 m/s along the path; the sidestep adds a little, never a jump.
          expect(Math.hypot(p.x - q.x, p.z - q.z), `t ${t.toFixed(3)} ${id}`).toBeLessThan(0.15);
        }
      }
      previous = now;
    }
    // The same moment gives the same picture, however it was reached.
    const again = videoBodies(scene, 1.0).map((p) => p.token.point);
    expect(videoBodies(scene, 1.0).map((p) => p.token.point)).toEqual(again);
  });
});
