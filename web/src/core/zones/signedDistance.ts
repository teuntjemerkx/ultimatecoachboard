// Port of Geometry/SignedDistance.swift. Swift computes in Float; every operation here is rounded to float32
// (Math.fround, Float32Array) so the results are bit-identical.
import { swiftRound } from "../spatial/swiftCompat";

const far = Math.fround(1e20);
const f32 = Math.fround;

/** Lower envelope of parabolas rooted at each sample (one dimension of the exact transform). */
function transform1D(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  if (n <= 0) return;
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const p = v[k];
      s = f32(f32(f32(f[q] + q * q) - f32(f[p] + p * p)) / (2 * (q - p)));
      if (s <= z[k]) k -= 1;
      else break;
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k += 1;
    const dq = q - v[k];
    d[q] = f32(f32(dq * dq) + f[v[k]]);
  }
}

/**
 * Signed distance fields for crisp glyphs and shapes at any scale (blueprint Section 3.2). Exact Euclidean distances
 * by the separable transform of Felzenszwalb and Huttenlocher.
 */
export const SignedDistance = {
  /** Squared Euclidean distance to the nearest feature pixel (where `feature` is true), per pixel. */
  squaredDistance(feature: readonly boolean[], width: number, height: number): Float32Array {
    if (feature.length !== width * height) throw new Error("mask size");
    const f = Float32Array.from(feature, (b) => (b ? 0 : far));
    const n = Math.max(width, height);
    const line = new Float32Array(n);
    const out = new Float32Array(n);
    const v = new Int32Array(n);
    const z = new Float32Array(n + 1);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) line[y] = f[y * width + x];
      transform1D(line, height, out, v, z);
      for (let y = 0; y < height; y++) f[y * width + x] = out[y];
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) line[x] = f[y * width + x];
      transform1D(line, width, out, v, z);
      for (let x = 0; x < width; x++) f[y * width + x] = out[x];
    }
    return f;
  },

  /**
   * An 8-bit signed distance field from 8-bit coverage: 128 is the edge, larger values are inside, and `spread`
   * pixels of distance map to the full range on each side.
   */
  field(coverage: ArrayLike<number>, width: number, height: number, spread: number): Uint8Array {
    const inside = Array.from(coverage, (c) => c >= 128);
    const toInside = SignedDistance.squaredDistance(inside, width, height);
    const toOutside = SignedDistance.squaredDistance(inside.map((b) => !b), width, height);
    const out = new Uint8Array(width * height);
    const sp = f32(spread);
    for (let i = 0; i < out.length; i++) {
      // Half a pixel shifts both distances onto the edge between the pixel centres.
      const signed = inside[i] ? f32(f32(Math.sqrt(toOutside[i])) - 0.5) : -f32(f32(Math.sqrt(toInside[i])) - 0.5);
      const value = f32(0.5 + f32(signed / f32(2 * sp)));
      out[i] = Math.max(0, Math.min(255, swiftRound(f32(value * 255))));
    }
    return out;
  },
};
