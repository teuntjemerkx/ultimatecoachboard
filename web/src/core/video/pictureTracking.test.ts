import { describe, expect, it } from "vitest";
import { V3 } from "../spatial/math3d";
import { VideoCamera } from "./courtCalibration";
import { PictureTracker, type PersonBox, type PictureFrame } from "./pictureTracking";
import { PersonDetection, PlayerTracker, TrackedPlayer, type VideoFrameObservation } from "./playerTracking";

/** A person's box: feet at (x, bottom), `h` pixels tall, in a jersey colour. */
const body = (x: number, bottom: number, h: number, appearance?: number[]): PersonBox =>
  ({ x: x - 0.2 * h, y: bottom - h, w: 0.4 * h, h, ...(appearance ? { appearance } : {}) });
const orange = [0.9, 0.45, 0.1], white = [0.92, 0.92, 0.92];
const fps = 30;

describe("following tapped players in the picture", () => {
  it("keeps two team-mates apart when they cross, by where each was heading", () => {
    // A runs right, B runs left along the same line, 100 px tall, crossing at 1 s; same jerseys.
    const frames: PictureFrame[] = Array.from({ length: 2 * fps + 1 }, (_, k) => {
      const t = k / fps;
      return { time: t, people: [body(300 + 300 * t, 500, 100, orange), body(900 - 300 * t, 503, 100, orange)] };
    });
    const [a, b] = PictureTracker.follow(frames, [{ keys: [{ frame: 0, box: 0 }] }, { keys: [{ frame: 0, box: 1 }] }]);
    expect(a.every((j) => j === 0)).toBe(true);
    expect(b.every((j) => j === 1)).toBe(true);
  });

  it("follows a player tapped when she comes into the picture, back to where she came in and on to the end", () => {
    // The server walks in from the bottom right at 1 s and runs into the court; she is tapped at 2 s.
    const frames: PictureFrame[] = Array.from({ length: 4 * fps }, (_, k) => {
      const t = k / fps;
      const people = [body(400, 300, 60, orange), body(600, 300, 60, white)];
      if (t >= 1) people.push(body(1100 - 150 * (t - 1), 720 - 60 * (t - 1), 260 - 50 * (t - 1), orange));
      return { time: t, people };
    });
    const [server] = PictureTracker.follow(frames, [{ keys: [{ frame: 2 * fps, box: 2 }] }]);
    expect(server.slice(0, fps).every((j) => j === -1)).toBe(true);
    expect(server.slice(fps).every((j) => j === 2)).toBe(true);
  });

  it("puts a lost player right with a second tap", () => {
    // A and B (same jerseys) walk into each other and stand as one box from 1 to 1.5 s; then A turns back the way she
    // came. Followed from the first tap alone, A goes on with the box that keeps her heading; tapped again at 2.5 s,
    // she is right from where they part.
    const frames: PictureFrame[] = Array.from({ length: 3 * fps }, (_, k) => {
      const t = k / fps;
      const ax = t < 1 ? 400 + 200 * t : t < 1.5 ? 600 : 600 - 200 * (t - 1.5);
      const bx = t < 1 ? 800 - 200 * t : t < 1.5 ? 600 : 600 + 200 * (t - 1.5);
      const people = t >= 1 && t < 1.5 ? [body(600, 500, 100, orange)] : [body(ax, 500, 100, orange), body(bx, 500, 100, orange)];
      return { time: t, people };
    });
    const isA = (k: number, j: number) => {
      const t = k / fps;
      if (t >= 1 && t < 1.5) return j === 0;
      return j === 0;
    };
    const once = PictureTracker.follow(frames, [{ keys: [{ frame: 0, box: 0 }] }, { keys: [{ frame: 0, box: 1 }] }]);
    const wrongOnce = once[0].filter((j, k) => k > 1.6 * fps && j >= 0 && !isA(k, j)).length;
    expect(wrongOnce, "followed from one tap, A takes B's way").toBeGreaterThan(10);
    const fixed = PictureTracker.follow(frames, [{ keys: [{ frame: 0, box: 0 }, { frame: 2.5 * fps, box: 0 }] },
      { keys: [{ frame: 0, box: 1 }] }]);
    const wrong = fixed[0].filter((j, k) => k > 1.6 * fps && j >= 0 && !isA(k, j)).length;
    expect(wrong).toBe(0);
    expect(fixed[0].slice(1.6 * fps).every((j) => j === 0)).toBe(true);
  });

  it("lets a hidden player wait rather than take someone standing next to her", () => {
    // A is hidden from 1 to 1.6 s; C stands still 80 px to her right all along, untapped.
    const frames: PictureFrame[] = Array.from({ length: 2 * fps }, (_, k) => {
      const t = k / fps;
      const people = [body(700, 500, 100, white)];
      if (t < 1 || t >= 1.6) people.unshift(body(620, 500, 100, orange));
      return { time: t, people };
    });
    const [a] = PictureTracker.follow(frames, [{ keys: [{ frame: 0, box: 0 }] }]);
    frames.forEach((f, k) => {
      const j = a[k];
      if (j >= 0) expect(f.people[j].appearance, `frame ${k}`).toEqual(orange);
    });
    expect(a[Math.round(1.8 * fps)]).toBe(0);
  });
});

describe("tracks from the picture", () => {
  it("makes a tapped player's track from her own detections, also a player who comes in late", () => {
    const camera = VideoCamera.lookingAt(new V3(0, 2.2, 14), new V3(0, 0, 0), 1100, 1280, 720);
    const foot = (x: number, z: number) => camera.project(V3.fromFloor({ x, z }, 0))!;
    const boxAt = (x: number, z: number, appearance: number[]) => {
      const f = foot(x, z), head = camera.project(V3.fromFloor({ x, z }, 1.75))!;
      return body(f.x, f.y, f.y - head.y, appearance);
    };
    // Two of ours at the net; the server walks in at 1 s from behind the end line (z 9.5) to (3, 7) by 3 s.
    const server = (t: number) => ({ x: 3, z: 9.5 - 1.25 * (t - 1) });
    const frames: VideoFrameObservation[] = [];
    for (let k = 0; k < 3 * fps; k++) {
      const t = k / fps, pose = k % 3 === 0;
      const spots: [number, number, number[]][] = [[-1, 1.5, orange], [1.5, 1.2, orange], [0.5, -1.5, white]];
      if (t >= 1) spots.push([server(t).x, server(t).z, orange]);
      const people = spots.map(([x, z, c]) => boxAt(x, z, c));
      const detections = pose ? spots.map(([x, z], i) => PersonDetection.create({ x, z }, foot(x, z), { box: people[i] })) : [];
      frames.push({ time: t, detections, people });
    }
    const tapped = [
      { time: 0, foot: foot(-1, 1.5), box: boxAt(-1, 1.5, orange) },
      { time: 2, foot: foot(server(2).x, server(2).z), box: boxAt(server(2).x, server(2).z, orange) },
    ];
    const tracks = new PlayerTracker().followInPicture(frames, tapped, camera);
    expect(tracks.length).toBe(2);
    const [mate, srv] = tracks;
    expect(mate.side).toBe("home");
    expect(TrackedPlayer.observedCount(mate)).toBe(30);
    expect(mate.samples.every((s) => Math.hypot(s.floor.x + 1, s.floor.z - 1.5) < 0.2)).toBe(true);
    // The server: seen from 1 s on, held where she came in before that.
    expect(TrackedPlayer.observedCount(srv)).toBe(20);
    for (const s of srv.samples) {
      const p = server(Math.max(1, s.time));
      expect(Math.hypot(s.floor.x - p.x, s.floor.z - p.z), `t ${s.time.toFixed(1)}`).toBeLessThan(0.3);
    }
  });
});
