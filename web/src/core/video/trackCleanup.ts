import type { VideoCamera } from "./courtCalibration";
import type { VideoPlayerSample } from "./videoScene";

/** Settings of the clean-up a rebuilt player's samples get before they are shown. */
export interface TrackCleanupSettings {
  /** How hard a player can change speed, m/s² (the smoother's process noise). */
  acceleration: number;
  /** Position noise of a measured sample at full confidence, and at none, m (without a camera). */
  noiseSure: number;
  noiseUnsure: number;
  /** With a camera: how far off the feet are read in the image at full confidence, and at none, pixels. */
  pixelsSure: number;
  pixelsUnsure: number;
  /** Faster than this between two samples is a tracking error, not a player (a sprint is about 7 m/s). */
  maxSpeed: number;
  /** Feet higher than this are a misreading (an attacker's feet reach some 0.8 m). */
  maxJump: number;
}

export const defaultTrackCleanup: TrackCleanupSettings = {
  acceleration: 5, noiseSure: 0.12, noiseUnsure: 0.4, pixelsSure: 4, pixelsUnsure: 12, maxSpeed: 6.5, maxJump: 0.85,
};

const g = 9.81;

/**
 * The positions and jumps of a rebuilt player made physically believable (web addition). The tracker and the pose
 * fit give a position every 0.1 s, but on real footage more than half of them are not seen (filled in along a
 * straight line, so the player glides) and the seen ones wobble by some 10 cm, with jumps of 8 to 9 m/s between two
 * samples; and the jump, read from how high the feet stand in the image, came out at 1.8 and 2.7 m on a club video.
 *
 * Positions: a Rauch-Tung-Striebel smoother over the whole rally on each floor axis, with a constant-velocity model
 * whose acceleration noise is a player's (`acceleration`), the seen samples as measurements, the unseen ones left to
 * the model: a smooth path through the gaps, with speed changes a body can make. How much a seen sample counts comes
 * from the camera: a few pixels of error at the feet move a player sideways by d/f of them, but along the view by
 * d²/(f h) (a camera 2.2 m up sees a player 20 m away a metre nearer or farther for 6 pixels), and more the lower the
 * confidence. Then no step faster than `maxSpeed`.
 *
 * Jumps: only where a player jumps in volleyball, at the net (block, attack) or behind an end line (a jump serve), for
 * between 0.25 and 1 s, seen, and not much longer than the flight its highest reading means (T = sqrt(8 h / g)); such a
 * jump becomes that free flight, a parabola centred on the stretch, at most `maxJump` high. Everything else stays on
 * the floor.
 */
export const TrackCleanup = {
  clean(samples: readonly VideoPlayerSample[], settings: TrackCleanupSettings = defaultTrackCleanup, camera?: VideoCamera): VideoPlayerSample[] {
    if (samples.length < 3) return samples.map((s) => ({ ...s }));
    const out = samples.map((s) => ({ ...s }));
    const sure = (s: VideoPlayerSample) => Math.max(0, Math.min(1, s.confidence));
    // Noise across and along the camera's view (x and z on the board: a camera behind an end line looks along z).
    const noise = (s: VideoPlayerSample): [number, number] => {
      if (!camera) {
        const n = settings.noiseUnsure + (settings.noiseSure - settings.noiseUnsure) * sure(s);
        return [n, n];
      }
      const px = settings.pixelsUnsure + (settings.pixelsSure - settings.pixelsUnsure) * sure(s);
      const c = camera.center, d = Math.max(2, Math.hypot(s.x - c.x, s.z - c.z)), h = Math.max(1, c.y), f = camera.focalLength;
      const across = (px * d) / f, along = (px * d * d) / (f * h);
      // Split by how the view runs over the floor at this player.
      const ux = (s.x - c.x) / d, uz = (s.z - c.z) / d;
      return [Math.hypot(across * uz, along * ux), Math.hypot(across * ux, along * uz)];
    };
    const n = samples.map(noise);
    const xs = TrackCleanup.smooth(samples.map((s) => s.time), samples.map((s) => (s.occluded ? undefined : s.x)),
      n.map((v) => v[0]), settings.acceleration);
    const zs = TrackCleanup.smooth(samples.map((s) => s.time), samples.map((s) => (s.occluded ? undefined : s.z)),
      n.map((v) => v[1]), settings.acceleration);
    if (xs && zs) out.forEach((s, i) => { s.x = xs[i]; s.z = zs[i]; });
    // No step faster than a sprint.
    for (let i = 1; i < out.length; i++) {
      const dt = Math.max(1e-3, out[i].time - out[i - 1].time);
      const dx = out[i].x - out[i - 1].x, dz = out[i].z - out[i - 1].z;
      const v = Math.hypot(dx, dz) / dt;
      if (v > settings.maxSpeed) {
        const k = settings.maxSpeed / v;
        out[i].x = out[i - 1].x + dx * k;
        out[i].z = out[i - 1].z + dz * k;
      }
    }
    TrackCleanup.cleanJumps(out, settings.maxJump);
    return out;
  },

  /**
   * RTS smoothing of one coordinate: `values[i]` undefined where it was not seen. Returns undefined when nothing was
   * seen at all (the caller keeps the samples as they are).
   */
  smooth(times: readonly number[], values: readonly (number | undefined)[], noise: readonly number[], acceleration: number): number[] | undefined {
    const first = values.findIndex((v) => v !== undefined);
    if (first < 0) return undefined;
    const n = times.length;
    // State (p, v), covariance [[a, b], [b, c]].
    type S = { p: number; v: number; a: number; b: number; c: number };
    const pred: S[] = new Array(n), filt: S[] = new Array(n);
    let s: S = { p: values[first]!, v: 0, a: noise[first] ** 2, b: 0, c: 4 };
    const q = acceleration * acceleration;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const dt = Math.max(1e-3, times[i] - times[i - 1]);
        // x = F x; P = F P Fᵀ + Q (white acceleration).
        const p = s.p + dt * s.v, v = s.v;
        const a = s.a + 2 * dt * s.b + dt * dt * s.c + (q * dt ** 4) / 4;
        const b = s.b + dt * s.c + (q * dt ** 3) / 2;
        const c = s.c + q * dt * dt;
        s = { p, v, a, b, c };
      }
      pred[i] = s;
      const z = i < first ? undefined : values[i];
      if (z !== undefined) {
        const r = noise[i] ** 2, k0 = s.a / (s.a + r), k1 = s.b / (s.a + r), y = z - s.p;
        s = { p: s.p + k0 * y, v: s.v + k1 * y, a: (1 - k0) * s.a, b: (1 - k0) * s.b, c: s.c - k1 * s.b };
      }
      filt[i] = s;
    }
    // Backward pass: x_s = x_f + C (x_s(next) - x_pred(next)), C = P_f Fᵀ P_pred(next)⁻¹.
    const out = new Array<number>(n);
    let next = { p: filt[n - 1].p, v: filt[n - 1].v };
    out[n - 1] = next.p;
    for (let i = n - 2; i >= 0; i--) {
      const f = filt[i], pr = pred[i + 1];
      const dt = Math.max(1e-3, times[i + 1] - times[i]);
      // P_f Fᵀ = [[a + dt b, b], [b + dt c, c]].
      const m00 = f.a + dt * f.b, m01 = f.b, m10 = f.b + dt * f.c, m11 = f.c;
      const det = pr.a * pr.c - pr.b * pr.b;
      if (Math.abs(det) < 1e-12) { out[i] = f.p; next = { p: f.p, v: f.v }; continue; }
      const i00 = pr.c / det, i01 = -pr.b / det, i11 = pr.a / det;
      const c00 = m00 * i00 + m01 * i01, c01 = m00 * i01 + m01 * i11;
      const c10 = m10 * i00 + m11 * i01, c11 = m10 * i01 + m11 * i11;
      const dp = next.p - pr.p, dv = next.v - pr.v;
      next = { p: f.p + c00 * dp + c01 * dv, v: f.v + c10 * dp + c11 * dv };
      out[i] = next.p;
    }
    return out;
  },

  /** Jumps kept only where and as long as volleyball jumps happen, each as a free flight (in place). */
  cleanJumps(out: VideoPlayerSample[], maxJump: number) {
    const raw = out.map((s) => (s.occluded ? 0 : Math.max(0, s.jump)));
    for (const s of out) s.jump = 0;
    let i = 0;
    while (i < out.length) {
      if (raw[i] <= 0.15) { i++; continue; }
      // One stretch above 15 cm; up to two readings that drop out in between (a missed frame mid-air) do not end it.
      let j = i;
      while (j + 1 < out.length && [1, 2, 3].some((d) => j + d < out.length && raw[j + d] > 0.15)) {
        j += [1, 2, 3].find((d) => raw[j + d] > 0.15)!;
      }
      // The readings that saw the player in the air (a reading of 0 inside is a dropout, not a landing).
      const seen: { t: number; h: number }[] = [];
      for (let k = i; k <= j; k++) if (raw[k] > 0.05) seen.push({ t: out[k].time, h: raw[k] });
      const highest = seen.reduce((m, r) => (r.h > m.h ? r : m), seen[0]);
      const t0 = seen[0].t, t1 = seen[seen.length - 1].t;
      const duration = t1 - t0 + 0.1;
      const z = Math.abs(out[i + seen.findIndex((r) => r === highest)]?.z ?? out[i].z);
      const where = z < 4.5 || z > 8.3;
      // The highest reading sets the flight (T = sqrt(8 h / g)); a stretch much longer than that flight is a misreading.
      const peak = Math.min(highest.h, maxJump);
      const T = Math.sqrt((8 * peak) / g);
      if (where && duration >= 0.2 && duration <= Math.min(1.0, T + 0.35)) {
        // The parabola's middle where it fits the readings best.
        const curve = (t: number, tc: number) => { const u = (2 * (t - tc)) / T; return Math.abs(u) < 1 ? peak * (1 - u * u) : 0; };
        let tc = highest.t, best = Infinity;
        for (let c = t0 - 0.1; c <= t1 + 0.1; c += 0.01) {
          const cost = seen.reduce((sum, r) => sum + (Math.min(r.h, maxJump) - curve(r.t, c)) ** 2, 0);
          if (cost < best) { best = cost; tc = c; }
        }
        for (const s of out) s.jump = Math.max(s.jump, curve(s.time, tc));
      }
      i = j + 1;
    }
  },
};
