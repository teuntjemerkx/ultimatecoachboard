import { describe, expect, it } from "vitest";
import { V3 } from "../../core/spatial";
import { CourtCalibration, VideoCamera } from "../../core/video";
import { oneBallEach } from "./detect";
import {
  farCourtBand, followBall, frameGrid, onFrameGrid, pickBalls, samplePlan, sameFrame, withoutFixtures, type TileObject,
} from "./pipeline";

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

  it("seeks into the frame on screen at each read's time", () => {
    // A browser that cuts a seek to whole microseconds and shows the last frame whose start, rounded to whole
    // microseconds (MP4) or milliseconds (WebM), is not after it: a seek to a frame's exact start can show the one before.
    const shows = (seek: number, fps: number, unit: number) => {
      const at = Math.floor(seek * 1e6);
      let frame = Math.floor(seek * fps) + 1;
      while (Math.round((frame / fps) * (1e6 / unit)) * unit > at) frame -= 1;
      return frame;
    };
    const own = (t: number, fps: number) => Math.floor(t * fps + 1e-6);
    for (const [start, end] of [[0, 4], [3.2, 7.2], [1.234, 5.234]]) {
      const plan = samplePlan(start, end);
      for (const fps of [24, 25, 30, 60]) {
        for (const unit of [1, 1000]) {
          for (const s of plan) expect(shows(s.seek, fps, unit), `${fps} fps at ${s.time}`).toBe(own(s.time, fps));
        }
      }
    }
    // Seeking to the times themselves, a 30 fps clip would show the frame before on every third read.
    const plan = samplePlan(0, 4);
    expect(plan.filter((s) => shows(s.time, 30, 1) !== own(s.time, 30)).length).toBe(40);
    // Under half a frame at 60 fps.
    expect(plan.every((s) => s.seek > s.time + 0.001 && s.seek < s.time + 1 / 120)).toBe(true);
  });

  it("puts a 24 fps clip's frames where they come up, from the seek times", () => {
    const shows = (seek: number) => Math.floor(seek * 24);
    let previous: number | undefined;
    const reads = samplePlan(2, 12).map((s) => {
      const frame = shows(s.seek), repeat = frame === previous;
      previous = frame;
      return { time: s.seek, repeat, frame };
    });
    const grid = frameGrid(reads)!;
    expect(grid?.fps).toBe(24);
    // Within a few milliseconds of each frame's start (the planned times would put them up to 5 ms early).
    for (const r of reads) expect(Math.abs(onFrameGrid(r.time, grid) - r.frame / 24)).toBeLessThan(0.003);
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

describe("Video to 3D: following the ball where the detector loses it", () => {
  /** A camera like the OK Hoče clip's (a 16 px ball is 26 m away), and one like the Orion clip's (9 m). */
  const far = VideoCamera.lookingAt(new V3(-2, 2.6, 23), new V3(0, 1, -5), 2000, 1280, 720);
  const near = VideoCamera.lookingAt(new V3(0, 2.2, 14), new V3(0, 1, 0), 670, 1280, 720);
  /** A far ball dropping in the picture, as the OK Hoče serve over their court (its image speeds up). */
  const ball = (t: number) => ({ x: 300 + 120 * t, y: 200 + 20 * t + 150 * t * t });
  /** 30 frames a second over 1.2 s; the detector sees the ball as a sports ball until `seen`, 16 px across. */
  const frames = (seen: number, at = ball) => Array.from({ length: 37 }, (_, k) => {
    const t = k / 30;
    return { time: t, balls: t <= seen + 1e-9 ? [{ ...at(t), score: 0.3, size: 16 }] : [] };
  });
  const box = (p: { x: number; y: number }, w: number, h: number): TileObject => ({ box: { x: p.x - w / 2, y: p.y - h / 2, w, h }, score: 0.03 });
  /**
   * The objects a zoomed tile boxes: the ball (when `ballThere`) as a box a little larger than the ball, and what is
   * around it: a head 40 px away, the wall band, a speck on the ball.
   */
  const tileObjects = (ballThere: (t: number) => boolean) => (fs: { time: number }[]) =>
    async (k: number, tile: { x: number; y: number; side: number }) => {
      const t = fs[k].time, p = ball(t);
      const inside = (q: { x: number; y: number }) => q.x >= tile.x && q.x < tile.x + tile.side && q.y >= tile.y && q.y < tile.y + tile.side;
      return [
        ...(ballThere(t) && inside(p) ? [box({ x: p.x + 0.5, y: p.y - 0.5 }, 18, 16)] : []),
        box({ x: p.x + 40, y: p.y }, 16, 17), box({ x: tile.x + tile.side / 2, y: tile.y + 30 }, tile.side, 40), box(p, 4, 4),
      ].filter((o) => inside({ x: o.box.x + o.box.w / 2, y: o.box.y + o.box.h / 2 }));
    };

  it("follows a far ball the detector loses, in zoomed tiles, without its box's size", async () => {
    const fs = frames(0.6);
    const looks = await followBall(fs, far, tileObjects(() => true)(fs));
    // Every frame after the detector's last point is read again once, and the ball found in each.
    expect(looks.map((l) => l.frame)).toEqual(Array.from({ length: 18 }, (_, i) => 19 + i));
    expect(looks.every((l) => l.found && l.tile.side >= 128 && l.tile.side <= 256)).toBe(true);
    const picked = pickBalls(fs, 1280);
    fs.forEach((f, k) => {
      expect(Math.hypot(picked[k]!.x - ball(f.time).x, picked[k]!.y - ball(f.time).y), `frame ${k}`).toBeLessThan(1);
      expect(picked[k]!.size).toBe(k <= 18 ? 16 : undefined);
    });
  });

  it("stops after three looks without the ball, and a ball-sized object off the path is no ball", async () => {
    // The ball is caught at 0.6 s: the tiles hold only the head, the band and the speck.
    const fs = frames(0.6);
    const looks = await followBall(fs, far, tileObjects(() => false)(fs));
    expect(looks.map((l) => l.frame)).toEqual([19, 20, 21]);
    expect(looks.some((l) => l.found)).toBe(false);
    expect(pickBalls(fs, 1280).slice(19).every((p) => p === undefined)).toBe(true);
    // Lost for two frames (behind a player), then followed on with a wider reach.
    const hidden = frames(0.6);
    const gaps = await followBall(hidden, far, tileObjects((t) => t < 0.75 || t > 0.81)(hidden));
    expect(gaps.filter((l) => !l.found).map((l) => l.frame)).toEqual([23, 24]);
    expect(gaps.filter((l) => l.found).length).toBe(16);
    expect(gaps.find((l) => l.frame === 25)!.reach).toBeCloseTo(2 * gaps[0].reach, 9);
  });

  it("does not follow a near ball, a ball held still, a repeated frame or the start of a path", async () => {
    // The same ball 9 m from the camera.
    const close = frames(0.6);
    expect(await followBall(close, near, tileObjects(() => true)(close))).toEqual([]);
    // Held at one pixel (a ball the server bounces, a head) until the detector stops seeing it.
    const held = frames(0.6, () => ({ x: 500, y: 300 }));
    expect(await followBall(held, far, tileObjects(() => true)(held))).toEqual([]);
    // A repeated frame is not read again.
    const fs = frames(0.6).map((f, k) => ({ ...f, repeat: k === 20 }));
    const looks = await followBall(fs, far, tileObjects(() => true)(fs));
    expect(looks.some((l) => l.frame === 20)).toBe(false);
    // A zoomed candidate alone starts no path.
    expect(pickBalls([{ time: 0, balls: [{ x: 50, y: 50, score: 0, zoomed: true }] }], 600)).toEqual([undefined]);
  });
});
