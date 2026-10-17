import { describe, expect, it } from "vitest";
import { V3 } from "../../core/spatial";
import { CourtCalibration, VideoCamera } from "../../core/video";
import { oneBallEach } from "./detect";
import { farCourtBand, frameGrid, onFrameGrid, pickBalls, samplePlan, sameFrame, withoutFixtures } from "./pipeline";

/** A ball thrown across a 600 px frame at 30 frames a second, with an antenna top the detector likes better. */
function flight(seconds: number) {
  return Array.from({ length: Math.round(seconds * 30) + 1 }, (_, k) => {
    const t = k / 30;
    return {
      time: t,
      balls: [
        { x: 514, y: 108, score: 0.45 },
        { x: 100 + 300 * t, y: 200 - 400 * t + 300 * t * t, score: k % 3 === 0 ? 0.3 : 0.15 },
      ],
    };
  });
}

describe("Video to 3D ball sampling", () => {
  it("reads two ball-only frames between each two pose frames", () => {
    const plan = samplePlan(2, 3);
    expect(plan.filter((s) => s.pose).map((s) => +s.time.toFixed(3))).toEqual([2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3]);
    expect(plan.length).toBe(31);
    plan.slice(1).forEach((s, i) => expect(s.time - plan[i].time).toBeCloseTo(1 / 30, 9));
    expect(plan.slice(0, 4).map((s) => s.pose)).toEqual([true, false, false, true]);
    expect(samplePlan(0, 1, 10, 0).every((s) => s.pose)).toBe(true);
  });

  it("drops candidates that stay put for a second, not a ball near the top of its flight", () => {
    const frames = flight(1.5);
    // The ball hangs at the top of a set for a few frames.
    for (const k of [20, 21, 22]) frames[k].balls[1] = { x: 300, y: 60, score: 0.3 };
    const kept = withoutFixtures(frames, 600);
    expect(kept.every((b) => b.every((c) => c.x !== 514))).toBe(true);
    expect(kept[21]).toEqual([{ x: 300, y: 60, score: 0.3 }]);
    expect(kept.every((b) => b.length === 1)).toBe(true);
  });

  it("follows the ball through weak detections and ignores a fixed light", () => {
    const frames = flight(1);
    const picked = pickBalls(frames, 600);
    expect(picked.every((p, k) => p !== undefined && Math.abs(p.x - frames[k].balls[1].x) < 1e-9)).toBe(true);
    // A weak candidate alone does not start a path.
    expect(pickBalls([{ time: 0, balls: [{ x: 50, y: 50, score: 0.15 }] }], 600)).toEqual([undefined]);
  });

  it("drops a head that stands still for a fifth of a second", () => {
    const frames = flight(1.5);
    // A far player's head, seen in seven frames out of eight over 0.27 s, at the ball's score.
    for (let k = 10; k <= 18; k++) if (k !== 13) frames[k].balls.push({ x: 455, y: 300 + (k % 2), score: 0.3 });
    const kept = withoutFixtures(frames, 600);
    expect(kept.every((b) => b.every((c) => c.x !== 455))).toBe(true);
    expect(kept.every((b) => b.length === 1)).toBe(true);
  });

  it("starts a new path where the pick jumps", () => {
    // A head the detector likes for four frames, then the ball elsewhere, weak after its first frame.
    const frames = Array.from({ length: 9 }, (_, k) => ({
      time: k / 30,
      balls: k < 4 ? [{ x: 300, y: 300, score: 0.3 }] : [{ x: 420 - 20 * (k - 4), y: 240 + 15 * (k - 4), score: k === 4 ? 0.5 : 0.15 }],
    }));
    const picked = pickBalls(frames, 1280);
    // Its speed is the ball's own, not the jump from the head: the weak frames are followed.
    expect(picked.slice(4).map((p) => p?.x)).toEqual([420, 400, 380, 360, 340]);
  });

  it("keeps one candidate per ball where the tiles overlap, with a whole box's size", () => {
    const merged = oneBallEach([
      { x: 519, y: 602, score: 0.6 },
      { x: 521, y: 601, score: 0.4, size: 27 },
      { x: 900, y: 100, score: 0.3, size: 8 },
    ]);
    expect(merged).toEqual([{ x: 521, y: 601, score: 0.6, size: 27 }, { x: 900, y: 100, score: 0.3, size: 8 }]);
  });

  it("finds the frame grid of a clip with fewer frames than are read", () => {
    // Reads at 30 a second; a seek shows the frame whose display interval holds the time.
    const reads = (fps: number, phase: number, from = 3.2) => {
      let previous: number | undefined;
      return Array.from({ length: 301 }, (_, k) => {
        const time = from + k / 30, frame = Math.floor(time * fps - phase);
        const repeat = frame === previous;
        previous = frame;
        return { time, repeat, shown: (frame + phase) / fps };
      });
    };
    for (const [fps, phase] of [[23.976, 0.98], [24, 0.3], [25, 0.55]]) {
      const r = reads(fps, phase);
      const grid = frameGrid(r)!;
      expect(grid, `${fps} fps`).toBeDefined();
      expect(grid.fps).toBe(fps);
      // Each read lands within a few milliseconds of the time its frame came up.
      for (const x of r) expect(Math.abs(onFrameGrid(x.time, grid) - x.shown), `${fps} fps at ${x.time}`).toBeLessThan(0.003);
    }
    // A clip with as many frames as are read hardly repeats; a still picture repeats every time.
    expect(frameGrid(reads(30, 0.2))).toBeUndefined();
    expect(frameGrid(reads(60, 0.2))).toBeUndefined();
    expect(frameGrid(reads(24, 0.3).map((x) => ({ ...x, repeat: true })))).toBeUndefined();
    // A few repeats hidden by compression noise, and a still moment, still give the grid.
    const noisy = reads(25, 0.55).map((x, k) => ({ ...x, repeat: k === 30 || k === 90 ? !x.repeat : x.repeat }));
    expect(frameGrid(noisy)?.fps).toBe(25);
  });

  it("tells a repeated frame from a new one", () => {
    const a = new Uint8ClampedArray(4 * 10000).fill(120);
    // A repeat after a re-encode: a few levels of noise everywhere.
    const b = a.map((v, i) => v + ((i * 7919) % 9) - 4);
    expect(sameFrame(a, a.slice())).toBe(true);
    expect(sameFrame(a, b)).toBe(true);
    // A player moved: a patch of 100 pixels changes.
    for (let i = 0; i < 400; i += 4) b[i] = 160;
    expect(sameFrame(a, b)).toBe(false);
  });
});

describe("Video to 3D: the far court read again, zoomed", () => {
  // A club's camera 2.2 m up and 14 m behind our end line (Orion D1 - Vocasa D3, 1280 x 720), marked on our half.
  const camera = CourtCalibration.solveNearHalf([{ x: 1213, y: 632 }, { x: 30, y: 632 }], [{ x: 420, y: 448 }, { x: 848, y: 448 }],
    "home", 1280, 720)!.camera;
  const box = (x: number, z: number, top: number, bottom = 0, width = 0.5) => {
    const head = camera.project(new V3(x, top, z))!, feet = camera.project(new V3(x, bottom, z))!;
    const w = (width * (feet.y - head.y)) / (top - bottom);
    return { x: feet.x - w / 2, y: head.y, w, h: feet.y - head.y };
  };

  it("covers their half and our players at the net", () => {
    const band = farCourtBand(camera)!;
    expect(band).toBeDefined();
    const inside = (p: { x: number; y: number }) => p.x >= band.x && p.x <= band.x + band.w && p.y >= band.y && p.y <= band.y + band.h;
    for (const [x, y, z] of [[-4.5, 0, 0], [4.5, 0, 0], [-4.5, 0, -9], [4.5, 0, -9], [0, 0, -12], [-4.5, 1.9, -1], [0, 0, 3]]) {
      expect(inside(camera.project(new V3(x, y, z))!)).toBe(true);
    }
    // A thin strip of the frame: tiles about a third of its width zoom in well over twice the frame.
    expect(band.h).toBeLessThan(0.25 * camera.height);
    expect(band.w / 2.5).toBeLessThan(0.2 * camera.width);
    expect(band.balls).toBe(false);
  });

  it("takes a whole far player, not legs alone or a group", () => {
    const band = farCourtBand(camera)!;
    expect(band.whole(box(1, -6, 1.8))).toBe(true);
    expect(band.whole(box(-3, -1, 1.85))).toBe(true);
    // A receiver crouching at the end line.
    expect(band.whole(box(2, -8.5, 1.3, 0, 0.6))).toBe(true);
    // A far player's legs, where a tile or a near player cuts the body off.
    expect(band.whole(box(2, -4, 0.9, 0, 0.35))).toBe(false);
    // Two players side by side in one box.
    expect(band.whole(box(0, -3, 1.8, 0, 1.6))).toBe(false);
  });

  it("is left out when their half is large in the picture or out of it", () => {
    // High above our side of the net, looking down into their half.
    const above = VideoCamera.lookingAt(new V3(0, 7, 4), new V3(0, 0, -5), 700, 1280, 720);
    expect(farCourtBand(above)).toBeUndefined();
    // Looking away from their half.
    const away = VideoCamera.lookingAt(new V3(0, 2, 14), new V3(0, 1, 30), 1000, 1280, 720);
    expect(farCourtBand(away)).toBeUndefined();
  });
});
