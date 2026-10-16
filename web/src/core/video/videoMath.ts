// Port of Video/VideoMath.swift: small dense numerics for the video reconstruction (Section 4): 3 x 3 matrices, a
// symmetric eigen solver, a linear solver, Levenberg-Marquardt and the Hungarian assignment.
import { Quat, V3 } from "../spatial/math3d";

/**
 * A pixel position in a video frame: origin at the top-left corner, x to the right, y down (normalised detector
 * coordinates must be converted by the app: x * width, y * height).
 */
export interface ImagePoint {
  x: number;
  y: number;
}

export const ImagePoint = {
  make(x: number, y: number): ImagePoint {
    return { x, y };
  },
  add(a: ImagePoint, b: ImagePoint): ImagePoint {
    return { x: a.x + b.x, y: a.y + b.y };
  },
  sub(a: ImagePoint, b: ImagePoint): ImagePoint {
    return { x: a.x - b.x, y: a.y - b.y };
  },
  mul(a: ImagePoint, s: number): ImagePoint {
    return { x: a.x * s, y: a.y * s };
  },
  distance(a: ImagePoint, b: ImagePoint): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  },
};

/** A 3 x 3 matrix stored by rows. */
export class Matrix3 {
  constructor(
    readonly r0: V3,
    readonly r1: V3,
    readonly r2: V3,
  ) {}

  static rows(r0: V3, r1: V3, r2: V3): Matrix3 {
    return new Matrix3(r0, r1, r2);
  }

  static columns(c0: V3, c1: V3, c2: V3): Matrix3 {
    return new Matrix3(new V3(c0.x, c1.x, c2.x), new V3(c0.y, c1.y, c2.y), new V3(c0.z, c1.z, c2.z));
  }

  /** The rotation matrix of a unit quaternion. */
  static fromQuat(q: Quat): Matrix3 {
    return Matrix3.columns(q.rotate(new V3(1, 0, 0)), q.rotate(new V3(0, 1, 0)), q.rotate(new V3(0, 0, 1)));
  }

  /** Row-major values. */
  static fromValues(m: readonly number[]): Matrix3 {
    return new Matrix3(new V3(m[0], m[1], m[2]), new V3(m[3], m[4], m[5]), new V3(m[6], m[7], m[8]));
  }

  static readonly identity = new Matrix3(new V3(1, 0, 0), new V3(0, 1, 0), new V3(0, 0, 1));

  /** Rotation about the world vertical by `yaw` (from +Z toward +X), as SkeletonModel's facing. */
  static yaw(a: number): Matrix3 {
    const c = Math.cos(a), s = Math.sin(a);
    return new Matrix3(new V3(c, 0, s), new V3(0, 1, 0), new V3(-s, 0, c));
  }

  /** Rodrigues: the rotation by |w| radians about w. */
  static rotation(w: V3): Matrix3 {
    const theta = w.length;
    if (!(theta > 1e-12)) return new Matrix3(new V3(1, -w.z, w.y), new V3(w.z, 1, -w.x), new V3(-w.y, w.x, 1));
    const k = w.mul(1 / theta), c = Math.cos(theta), s = Math.sin(theta), v = 1 - c;
    return new Matrix3(
      new V3(c + k.x * k.x * v, k.x * k.y * v - k.z * s, k.x * k.z * v + k.y * s),
      new V3(k.y * k.x * v + k.z * s, c + k.y * k.y * v, k.y * k.z * v - k.x * s),
      new V3(k.z * k.x * v - k.y * s, k.z * k.y * v + k.x * s, c + k.z * k.z * v),
    );
  }

  get values(): number[] {
    const { r0, r1, r2 } = this;
    return [r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, r2.x, r2.y, r2.z];
  }
  get c0(): V3 {
    return new V3(this.r0.x, this.r1.x, this.r2.x);
  }
  get c1(): V3 {
    return new V3(this.r0.y, this.r1.y, this.r2.y);
  }
  get c2(): V3 {
    return new V3(this.r0.z, this.r1.z, this.r2.z);
  }
  get transpose(): Matrix3 {
    return new Matrix3(this.c0, this.c1, this.c2);
  }
  get determinant(): number {
    return this.r0.dot(this.r1.cross(this.r2));
  }
  /** The quaternion of a rotation matrix. */
  get quat(): Quat {
    return Quat.fromBasis(this.c0, this.c1, this.c2).normalized;
  }

  /** Swift `m * v`. */
  apply(v: V3): V3 {
    return new V3(this.r0.dot(v), this.r1.dot(v), this.r2.dot(v));
  }

  /** Swift `a * b`. */
  mul(b: Matrix3): Matrix3 {
    const bc0 = b.c0, bc1 = b.c1, bc2 = b.c2;
    const a = this;
    return new Matrix3(
      new V3(a.r0.dot(bc0), a.r0.dot(bc1), a.r0.dot(bc2)),
      new V3(a.r1.dot(bc0), a.r1.dot(bc1), a.r1.dot(bc2)),
      new V3(a.r2.dot(bc0), a.r2.dot(bc1), a.r2.dot(bc2)),
    );
  }

  /** Swift `m * s`. */
  scale(s: number): Matrix3 {
    return new Matrix3(this.r0.mul(s), this.r1.mul(s), this.r2.mul(s));
  }

  get inverse(): Matrix3 | undefined {
    const det = this.determinant;
    if (!(Math.abs(det) > 1e-300)) return undefined;
    // Rows of the inverse are the cross products of the columns, divided by the determinant.
    const a = this.c0, b = this.c1, c = this.c2;
    return new Matrix3(b.cross(c).mul(1 / det), c.cross(a).mul(1 / det), a.cross(b).mul(1 / det));
  }
}

export const LinearAlgebra = {
  /**
   * Eigen-decomposition of a symmetric n x n matrix (row-major) by cyclic Jacobi rotations. Eigenvalues ascend;
   * `vectors[i]` is the unit eigenvector of `values[i]`.
   */
  symmetricEigen(matrix: readonly number[], n: number, maxSweeps = 80): { values: number[]; vectors: number[][] } {
    const a = [...matrix];
    const v = new Array<number>(n * n).fill(0);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    let scale = 0;
    for (const x of a) scale += x * x;
    const tolerance = Math.max(scale, 1e-300) * 1e-30;
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) if (q !== p) off += a[p * n + q] * a[p * n + q];
      if (off <= tolerance) break;
      for (let p = 0; p < n - 1; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = a[p * n + q];
          if (Math.abs(apq) < 1e-300) continue;
          const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
          const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k * n + p], akq = a[k * n + q];
            a[k * n + p] = c * akp - s * akq;
            a[k * n + q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p * n + k], aqk = a[q * n + k];
            a[p * n + k] = c * apk - s * aqk;
            a[q * n + k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k * n + p], vkq = v[k * n + q];
            v[k * n + p] = c * vkp - s * vkq;
            v[k * n + q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i] - a[j * n + j]);
    return {
      values: order.map((i) => a[i * n + i]),
      vectors: order.map((j) => Array.from({ length: n }, (_, i) => v[i * n + j])),
    };
  },

  /** The rotation nearest to m in the Frobenius norm (polar decomposition through the eigenvectors of m^T m). */
  nearestRotation(m: Matrix3): Matrix3 {
    const mtm = m.transpose.mul(m);
    const { vectors } = LinearAlgebra.symmetricEigen(mtm.values, 3);
    // Descending singular values: v1 is the last eigenvector.
    const v1 = new V3(vectors[2][0], vectors[2][1], vectors[2][2]);
    const v2 = new V3(vectors[1][0], vectors[1][1], vectors[1][2]);
    const v3 = new V3(vectors[0][0], vectors[0][1], vectors[0][2]);
    let u1 = m.apply(v1);
    if (u1.length < 1e-15) return Matrix3.identity;
    u1 = u1.normalized;
    let u2 = m.apply(v2);
    u2 = u2.sub(u1.mul(u1.dot(u2)));
    if (u2.length < 1e-12) {
      // Rank one: any unit vector perpendicular to u1.
      u2 = Math.abs(u1.x) < 0.9 ? new V3(1, 0, 0).cross(u1) : new V3(0, 1, 0).cross(u1);
    }
    u2 = u2.normalized;
    const detV = v1.dot(v2.cross(v3));
    const u3 = u1.cross(u2).mul(detV >= 0 ? 1 : -1);
    // R = sum u_i v_i^T.
    const outer = (a: V3, b: V3) => new Matrix3(b.mul(a.x), b.mul(a.y), b.mul(a.z));
    const r = [outer(u1, v1), outer(u2, v2), outer(u3, v3)];
    return new Matrix3(r[0].r0.add(r[1].r0).add(r[2].r0), r[0].r1.add(r[1].r1).add(r[2].r1), r[0].r2.add(r[1].r2).add(r[2].r2));
  },

  /** Solves A x = b for a square n x n system (row-major) by Gaussian elimination with partial pivoting. */
  solve(matrix: readonly number[], rhs: readonly number[], n: number): number[] | undefined {
    const a = [...matrix], b = [...rhs];
    let scale = 0;
    for (const x of a) scale = Math.max(scale, Math.abs(x));
    if (!(scale > 0)) return undefined;
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(a[r * n + col]) > Math.abs(a[pivot * n + col])) pivot = r;
      if (!(Math.abs(a[pivot * n + col]) > scale * 1e-15)) return undefined;
      if (pivot !== col) {
        for (let k = 0; k < n; k++) {
          const t = a[col * n + k];
          a[col * n + k] = a[pivot * n + k];
          a[pivot * n + k] = t;
        }
        const t = b[col];
        b[col] = b[pivot];
        b[pivot] = t;
      }
      const d = a[col * n + col];
      for (let r = col + 1; r < n; r++) {
        const f = a[r * n + col] / d;
        if (f === 0) continue;
        for (let k = col; k < n; k++) a[r * n + k] -= f * a[col * n + k];
        b[r] -= f * b[col];
      }
    }
    const x = new Array<number>(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= a[r * n + k] * x[k];
      x[r] = s / a[r * n + r];
    }
    return x.every(Number.isFinite) ? x : undefined;
  },

  /** Least squares for an over-determined system given as rows (normal equations, n unknowns). */
  leastSquares(rows: readonly (readonly number[])[], rhs: readonly number[], n: number): number[] | undefined {
    const ata = new Array<number>(n * n).fill(0), atb = new Array<number>(n).fill(0);
    const m = Math.min(rows.length, rhs.length);
    for (let k = 0; k < m; k++) {
      const row = rows[k], y = rhs[k];
      for (let i = 0; i < n; i++) {
        atb[i] += row[i] * y;
        for (let j = 0; j < n; j++) ata[i * n + j] += row[i] * row[j];
      }
    }
    return LinearAlgebra.solve(ata, atb, n);
  },
};

/** The result of a Levenberg-Marquardt minimisation. */
export interface LMResult {
  x: number[];
  /** Sum of squared residuals at x. */
  cost: number;
  iterations: number;
}

/** Levenberg-Marquardt least squares with a central-difference Jacobian and Marquardt's diagonal scaling. */
export const LevenbergMarquardt = {
  /**
   * Minimises |r(x)|^2. `residuals` returns undefined for an invalid x (treated as infinitely bad); `steps` are the
   * finite-difference steps per parameter; `clamp` keeps parameters in their valid range after each step.
   */
  minimize(x0: readonly number[], steps: readonly number[], residuals: (x: number[]) => number[] | undefined,
    options: { maxIterations?: number; tolerance?: number; clamp?: (x: number[]) => number[] } = {}): LMResult | undefined {
    const maxIterations = options.maxIterations ?? 60, tolerance = options.tolerance ?? 1e-12, clamp = options.clamp;
    const n = x0.length;
    let x = clamp ? clamp([...x0]) : [...x0];
    let r = residuals(x);
    if (!r) return undefined;
    let cost = 0;
    for (const v of r) cost += v * v;
    let mu = 1e-3;
    let iterations = 0;
    for (let iter = 0; iter < maxIterations; iter++) {
      iterations += 1;
      const m = r.length;
      // Jacobian, column by column.
      const jac = new Float64Array(m * n);
      for (let j = 0; j < n; j++) {
        const xp = [...x], xm = [...x];
        xp[j] += steps[j];
        xm[j] -= steps[j];
        const rp = residuals(xp), rm = residuals(xm);
        const okP = rp !== undefined && rp.length === m, okM = rm !== undefined && rm.length === m;
        if (okP && okM) {
          for (let i = 0; i < m; i++) jac[i * n + j] = (rp[i] - rm[i]) / (2 * steps[j]);
        } else if (okP) {
          for (let i = 0; i < m; i++) jac[i * n + j] = (rp[i] - r[i]) / steps[j];
        } else if (okM) {
          for (let i = 0; i < m; i++) jac[i * n + j] = (r[i] - rm[i]) / steps[j];
        }
      }
      const jtj = new Array<number>(n * n).fill(0), jtr = new Array<number>(n).fill(0);
      for (let i = 0; i < m; i++) {
        const base = i * n;
        for (let a = 0; a < n; a++) {
          const ja = jac[base + a];
          if (ja === 0) continue;
          jtr[a] += ja * r[i];
          for (let b = a; b < n; b++) jtj[a * n + b] += ja * jac[base + b];
        }
      }
      for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) jtj[a * n + b] = jtj[b * n + a];
      let improved = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const damped = [...jtj];
        for (let a = 0; a < n; a++) damped[a * n + a] += mu * Math.max(jtj[a * n + a], 1e-12);
        const delta = LinearAlgebra.solve(damped, jtr.map((v) => -v), n);
        if (!delta) {
          mu *= 10;
          continue;
        }
        let xn = x.map((v, i) => v + delta[i]);
        if (clamp) xn = clamp(xn);
        const rn = residuals(xn);
        if (rn) {
          let cn = 0;
          for (const v of rn) cn += v * v;
          if (cn < cost) {
            const gain = cost - cn;
            x = xn;
            r = rn;
            cost = cn;
            mu = Math.max(mu / 3, 1e-12);
            improved = true;
            if (gain <= tolerance * Math.max(cost, 1e-300)) return { x, cost, iterations };
            break;
          }
        }
        mu *= 4;
      }
      if (!improved) break;
    }
    return { x, cost, iterations };
  },
};

/** Optimal assignment (Kuhn-Munkres with potentials, O(n^2 m)). */
export const Hungarian = {
  /**
   * The column assigned to each row minimising the total cost, undefined for rows left over when there are more rows
   * than columns. Costs must be finite; use a large value for forbidden pairs and filter them afterwards.
   */
  solve(cost: readonly (readonly number[])[]): (number | undefined)[] {
    const rows = cost.length;
    const cols = cost[0]?.length ?? 0;
    if (rows === 0 || cols === 0) return new Array<number | undefined>(rows).fill(undefined);
    if (rows > cols) {
      // Transpose so that rows <= columns.
      const t = Array.from({ length: cols }, (_, c) => Array.from({ length: rows }, (_, r) => cost[r][c]));
      const colToRow = Hungarian.solve(t);
      const out = new Array<number | undefined>(rows).fill(undefined);
      colToRow.forEach((r, c) => { if (r !== undefined) out[r] = c; });
      return out;
    }
    const n = rows, m = cols;
    const u = new Array<number>(n + 1).fill(0), v = new Array<number>(m + 1).fill(0);
    const p = new Array<number>(m + 1).fill(0), way = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array<number>(m + 1).fill(Infinity);
      const used = new Array<boolean>(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0 !== 0);
    }
    const out = new Array<number | undefined>(n).fill(undefined);
    for (let j = 1; j <= m; j++) if (p[j] !== 0) out[p[j] - 1] = j - 1;
    return out;
  },
};

/** The angle wrapped into (-pi, pi] (Swift `Double.wrappedAngle`). */
export function wrappedAngle(x: number): number {
  let a = x % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}
