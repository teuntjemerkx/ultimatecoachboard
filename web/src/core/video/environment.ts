// Port of Video/Environment.swift: the clean plate and the hall around the court (Section 4.5).
// `VideoCamera.normalizedProjection` is a getter of VideoCamera (courtCalibration.ts).
import { CourtFrame } from "../match/court";
import { V3 } from "../spatial/math3d";
import type { VideoCamera } from "./courtCalibration";

/**
 * The empty hall behind the players (Section 4.5): a temporal median over sampled frames removes everything that
 * moves (players, ball), leaving the court, the walls and the stands as one still image.
 */
export const CleanPlate = {
  /**
   * Per-pixel, per-channel temporal median of the unmasked samples. `frames` are RGBA8 images of `width` x `height`
   * (row-major, 4 bytes per pixel); `masks`, when given, hold one byte per pixel per frame, non-zero where a person is
   * (those samples are ignored). Pixels never seen unmasked take the colour of the nearest seen pixel in their row or
   * column (ties prefer the row, then left and up; repeated until filled). Alpha is 255. Frames or masks of the wrong
   * size are skipped.
   */
  median(frames: readonly ArrayLike<number>[], masks: readonly ArrayLike<number>[] | undefined, width: number, height: number): Uint8Array {
    const pixels = width * height;
    const out = new Uint8Array(Math.max(pixels, 0) * 4);
    const usable: number[] = [];
    frames.forEach((f, k) => { if (f.length >= pixels * 4) usable.push(k); });
    const n = usable.length;
    if (!(pixels > 0) || n === 0) return out;
    const counts = new Int32Array(pixels);
    const samples = new Uint8Array(pixels * n);
    const valid = new Uint8Array(pixels);
    for (let channel = 0; channel < 3; channel++) {
      counts.fill(0);
      for (const k of usable) {
        const mask = masks && k < masks.length && masks[k].length >= pixels ? masks[k] : undefined;
        const f = frames[k];
        if (mask) {
          for (let i = 0; i < pixels; i++) {
            if (mask[i] !== 0) continue;
            samples[i * n + counts[i]] = f[i * 4 + channel];
            counts[i] += 1;
          }
        } else {
          for (let i = 0; i < pixels; i++) {
            samples[i * n + counts[i]] = f[i * 4 + channel];
            counts[i] += 1;
          }
        }
      }
      for (let i = 0; i < pixels; i++) {
        const m = counts[i];
        if (m === 0) continue;
        valid[i] = 1;
        out[i * 4 + channel] = CleanPlate.medianInPlace(samples, i * n, m);
      }
    }
    CleanPlate.fill(out, valid, width, height);
    for (let i = 0; i < pixels; i++) out[i * 4 + 3] = 255;
    return out;
  },

  /** The median of `count` bytes from `offset` (the mean of the two middle ones for an even count), reordering them. */
  medianInPlace(a: Uint8Array, offset: number, count: number): number {
    const k = (count - 1) >> 1;
    const lower = CleanPlate.select(a, offset, count, k);
    if (count % 2 !== 0) return lower;
    // Everything after k is >= a[k]: the upper middle is the smallest of them.
    let upper = 255;
    for (let i = k + 1; i < count; i++) if (a[offset + i] < upper) upper = a[offset + i];
    return (lower + upper + 1) >> 1;
  },

  /** Hoare's selection: the k-th smallest of `count` bytes, leaving smaller ones before and larger ones after it. */
  select(a: Uint8Array, offset: number, count: number, k: number): number {
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const pivot = a[offset + ((lo + hi) >> 1)];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[offset + i] < pivot) i += 1;
        while (a[offset + j] > pivot) j -= 1;
        if (i <= j) {
          const t = a[offset + i];
          a[offset + i] = a[offset + j];
          a[offset + j] = t;
          i += 1;
          j -= 1;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return a[offset + k];
    }
    return a[offset + k];
  },

  /** Fills invalid pixels from the nearest valid one along their row or column. */
  fill(img: Uint8Array, input: Uint8Array, w: number, h: number): void {
    const valid = Uint8Array.from(input);
    const anyValid = () => valid.some((v) => v !== 0);
    const anyInvalid = () => valid.some((v) => v === 0);
    if (!anyValid()) return;
    const source = new Int32Array(w * h), distance = new Int32Array(w * h);
    while (anyInvalid()) {
      source.fill(-1);
      distance.fill(0x7fffffff);
      const consider = (i: number, from: number, d: number) => {
        if (d < distance[i]) { distance[i] = d; source[i] = from; }
      };
      for (let y = 0; y < h; y++) {
        let last = -1;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (valid[i]) last = x;
          else if (last >= 0) consider(i, y * w + last, x - last);
        }
        last = -1;
        for (let x = w - 1; x >= 0; x--) {
          const i = y * w + x;
          if (valid[i]) last = x;
          else if (last >= 0) consider(i, y * w + last, last - x);
        }
      }
      for (let x = 0; x < w; x++) {
        let last = -1;
        for (let y = 0; y < h; y++) {
          const i = y * w + x;
          if (valid[i]) last = y;
          else if (last >= 0) consider(i, last * w + x, y - last);
        }
        last = -1;
        for (let y = h - 1; y >= 0; y--) {
          const i = y * w + x;
          if (valid[i]) last = y;
          else if (last >= 0) consider(i, last * w + x, last - y);
        }
      }
      let progress = false;
      for (let i = 0; i < w * h; i++) {
        if (valid[i] || source[i] < 0) continue;
        const s = source[i];
        img[i * 4] = img[s * 4];
        img[i * 4 + 1] = img[s * 4 + 1];
        img[i * 4 + 2] = img[s * 4 + 2];
        progress = true;
      }
      if (!progress) return;
      for (let i = 0; i < w * h; i++) if (source[i] >= 0) valid[i] = 1;
    }
  },
};

/** The Swift Codable shape of the hall. */
export interface HallEnvironmentJSON {
  sideClearance: number;
  endClearance: number;
  height: number;
}

/**
 * The hall around the court as a box (Section 4.5), textured from the clean plate so a POV camera anywhere on court
 * sees the real hall. The floor (y = 0) extends beyond the court lines to the walls; the walls stand `sideClearance`
 * beyond the sidelines and `endClearance` beyond the end lines; the ceiling is at `height`.
 *
 * Texturing, for the renderer's shader: a point p on the box is looked up in the video frame through the calibrated
 * camera, `c = R (p - C)`, `u = (f c.x / c.z + w / 2) / w`, `v = (f c.y / c.z + h / 2) / h` (v down, 0...1), which is
 * `normalizedProjection` applied to (p, 1) followed by the divide by its third component. The lookup is valid when
 * `c.z > 0` and u, v lie in 0...1. Otherwise the hall is assumed symmetric and the same test is repeated for p
 * mirrored across X = 0, then across Z = 0, then both (a 180-degree turn); a mirrored hit is flagged so the shader can
 * dim it. With no hit the shader falls back to a neutral wall colour.
 */
export class HallEnvironment {
  constructor(
    readonly sideClearance = 7,
    readonly endClearance = 8,
    readonly height = 10,
  ) {}

  /** Half extents of the box: walls at x = +-halfWidth and z = +-halfLength. */
  get halfWidth(): number {
    return CourtFrame.halfWidth + this.sideClearance;
  }
  get halfLength(): number {
    return 9 + this.endClearance;
  }

  contains(p: V3): boolean {
    return Math.abs(p.x) <= this.halfWidth && Math.abs(p.z) <= this.halfLength && p.y >= 0 && p.y <= this.height;
  }

  /**
   * Where a ray from a point inside the hall leaves it (floor, a wall or the ceiling): what the POV camera sees in
   * that direction behind everything modelled. Undefined when the origin is outside.
   */
  exitPoint(o: V3, d: V3): V3 | undefined {
    if (!this.contains(o)) return undefined;
    let t = Infinity;
    const face = (o: number, d: number, lo: number, hi: number) => {
      if (d > 1e-12) t = Math.min(t, (hi - o) / d);
      else if (d < -1e-12) t = Math.min(t, (lo - o) / d);
    };
    face(o.x, d.x, -this.halfWidth, this.halfWidth);
    face(o.y, d.y, 0, this.height);
    face(o.z, d.z, -this.halfLength, this.halfLength);
    return Number.isFinite(t) ? o.add(d.mul(t)) : undefined;
  }

  /**
   * The video-frame coordinates (0...1, v down) that texture a world point, trying the point itself, then its mirror
   * images across X = 0, Z = 0 and both; `mirrored` is set when a mirror image was used. Undefined when none is in the
   * frame. `margin` shrinks the usable frame (normalised units) to avoid sampling the very edge.
   */
  uv(p: V3, camera: VideoCamera, margin = 0): { u: number; v: number; mirrored: boolean } | undefined {
    const candidates: [V3, boolean][] = [[p, false], [new V3(-p.x, p.y, p.z), true], [new V3(p.x, p.y, -p.z), true], [new V3(-p.x, p.y, -p.z), true]];
    for (const [q, mirrored] of candidates) {
      const c = camera.cameraCoordinates(q);
      if (!(c.z > 0.05)) continue;
      const u = ((camera.focalLength * c.x) / c.z + camera.width / 2) / camera.width;
      const v = ((camera.focalLength * c.y) / c.z + camera.height / 2) / camera.height;
      if (u >= margin && u <= 1 - margin && v >= margin && v <= 1 - margin) return { u, v, mirrored };
    }
    return undefined;
  }

  encode(): HallEnvironmentJSON {
    return { sideClearance: this.sideClearance, endClearance: this.endClearance, height: this.height };
  }

  static decode(j: HallEnvironmentJSON): HallEnvironment {
    return new HallEnvironment(j.sideClearance, j.endClearance, j.height);
  }
}
