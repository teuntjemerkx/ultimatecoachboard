// Port of Spatial/Math3D.swift (plus Quat(basisX:y:z:) and Mat4.perspectiveReversedZ of CameraPose.swift).
// Small, dependency-free 3D math in doubles. World frame (blueprint Section 0): metres, Y up, the floor at y = 0;
// court X across, Z along (home Z > 0). Value types: every operation returns a new object.
import type { FloorPoint } from "../match/court";

export class V3 {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {}

  static readonly zero = new V3(0, 0, 0);
  static readonly up = new V3(0, 1, 0);

  /** A floor point lifted to height y (Swift `V3(_ p: FloorPoint, y:)`). */
  static fromFloor(p: FloorPoint, y = 0): V3 {
    return new V3(p.x, y, p.z);
  }

  add(b: V3): V3 {
    return new V3(this.x + b.x, this.y + b.y, this.z + b.z);
  }
  sub(b: V3): V3 {
    return new V3(this.x - b.x, this.y - b.y, this.z - b.z);
  }
  mul(s: number): V3 {
    return new V3(this.x * s, this.y * s, this.z * s);
  }
  neg(): V3 {
    return new V3(-this.x, -this.y, -this.z);
  }
  dot(b: V3): number {
    return this.x * b.x + this.y * b.y + this.z * b.z;
  }
  cross(b: V3): V3 {
    return new V3(this.y * b.z - this.z * b.y, this.z * b.x - this.x * b.z, this.x * b.y - this.y * b.x);
  }
  get length(): number {
    return Math.sqrt(this.dot(this));
  }
  get normalized(): V3 {
    const l = this.length;
    return l > 0 ? this.mul(1 / l) : this;
  }
  get floor(): FloorPoint {
    return { x: this.x, z: this.z };
  }
  /** A copy with one component replaced (Swift's `var v = ...; v.y = ...`). */
  with(c: { x?: number; y?: number; z?: number }): V3 {
    return new V3(c.x ?? this.x, c.y ?? this.y, c.z ?? this.z);
  }
  equals(b: V3): boolean {
    return this.x === b.x && this.y === b.y && this.z === b.z;
  }
  toJSON(): { x: number; y: number; z: number } {
    return { x: this.x, y: this.y, z: this.z };
  }
}

/** Unit quaternion for rotations (x, y, z vector part, w scalar). */
export class Quat {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly w: number,
  ) {}

  static readonly identity = new Quat(0, 0, 0, 1);

  static fromAxisAngle(axis: V3, angle: number): Quat {
    const a = axis.normalized, s = Math.sin(angle / 2);
    return new Quat(a.x * s, a.y * s, a.z * s, Math.cos(angle / 2));
  }

  /** The rotation whose columns are the orthonormal basis x, y, z (Shepperd's method). */
  static fromBasis(x: V3, y: V3, z: V3): Quat {
    const m00 = x.x, m10 = x.y, m20 = x.z;
    const m01 = y.x, m11 = y.y, m21 = y.z;
    const m02 = z.x, m12 = z.y, m22 = z.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      return new Quat((m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s);
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      return new Quat(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      return new Quat((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      return new Quat((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
    }
  }

  /** Hamilton product (Swift `a * b`). */
  mul(b: Quat): Quat {
    const a = this;
    return new Quat(
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    );
  }
  /** Swift `q * s`. */
  scale(s: number): Quat {
    return new Quat(this.x * s, this.y * s, this.z * s, this.w * s);
  }
  add(b: Quat): Quat {
    return new Quat(this.x + b.x, this.y + b.y, this.z + b.z, this.w + b.w);
  }
  get conjugate(): Quat {
    return new Quat(-this.x, -this.y, -this.z, this.w);
  }
  dot(b: Quat): number {
    return this.x * b.x + this.y * b.y + this.z * b.z + this.w * b.w;
  }
  get norm(): number {
    return Math.sqrt(this.dot(this));
  }
  get normalized(): Quat {
    const n = this.norm;
    return n > 0 ? this.scale(1 / n) : Quat.identity;
  }

  rotate(v: V3): V3 {
    const u = new V3(this.x, this.y, this.z);
    const t = u.cross(v).mul(2);
    return v.add(t.mul(this.w)).add(u.cross(t));
  }

  /** Spherical interpolation along the shortest arc. */
  slerp(to: Quat, t: number): Quat {
    let b = to;
    let c = this.dot(b);
    if (c < 0) {
      b = b.scale(-1);
      c = -c;
    }
    if (c > 0.9995) return this.scale(1 - t).add(b.scale(t)).normalized;
    const theta = Math.acos(Math.min(1, c));
    const s = Math.sin(theta);
    return this.scale(Math.sin((1 - t) * theta) / s).add(b.scale(Math.sin(t * theta) / s)).normalized;
  }

  equals(b: Quat): boolean {
    return this.x === b.x && this.y === b.y && this.z === b.z && this.w === b.w;
  }
  toJSON(): { x: number; y: number; z: number; w: number } {
    return { x: this.x, y: this.y, z: this.z, w: this.w };
  }
}

/** A rotation followed by a translation. */
export class Rigid {
  constructor(
    readonly rotation: Quat = Quat.identity,
    readonly translation: V3 = V3.zero,
  ) {}

  static readonly identity = new Rigid();

  apply(p: V3): V3 {
    return this.rotation.rotate(p).add(this.translation);
  }

  /** self ∘ other: apply `other` first (Swift `a * b`). */
  mul(b: Rigid): Rigid {
    return new Rigid(this.rotation.mul(b.rotation).normalized, this.apply(b.translation));
  }

  get inverse(): Rigid {
    const r = this.rotation.conjugate;
    return new Rigid(r, r.rotate(this.translation).neg());
  }
}

/** Unit dual quaternion for skinning (Kavan et al.): blends rotations and translations without candy-wrapping. */
export class DualQuat {
  constructor(
    readonly real: Quat,
    readonly dual: Quat,
  ) {}

  /** Swift `DualQuat(_ r: Rigid)`. */
  static fromRigid(r: Rigid): DualQuat {
    const real = r.rotation.normalized;
    const t = new Quat(r.translation.x, r.translation.y, r.translation.z, 0);
    return new DualQuat(real, t.mul(real).scale(0.5));
  }

  get rigid(): Rigid {
    const n = this.real.norm;
    const r = this.real.scale(1 / n), d = this.dual.scale(1 / n);
    const t = d.scale(2).mul(r.conjugate);
    return new Rigid(r, new V3(t.x, t.y, t.z));
  }

  transform(p: V3): V3 {
    return this.rigid.apply(p);
  }

  /** Weighted blend with antipodality correction, then normalization (DLB). */
  static blend(items: readonly (readonly [DualQuat, number])[]): DualQuat {
    if (items.length === 0) return DualQuat.fromRigid(Rigid.identity);
    const pivot = items[0][0].real;
    let r = new Quat(0, 0, 0, 0), d = new Quat(0, 0, 0, 0);
    for (const [q, w] of items) {
      const s = pivot.dot(q.real) < 0 ? -w : w;
      r = r.add(q.real.scale(s));
      d = d.add(q.dual.scale(s));
    }
    const n = r.norm;
    return new DualQuat(r.scale(1 / n), d.scale(1 / n));
  }
}

/** Column-major 4 x 4 matrix (Metal's convention), clip-space depth in 0...1. */
export class Mat4 {
  readonly m: number[];

  constructor(m: readonly number[]) {
    if (m.length !== 16) throw new Error("Mat4 needs 16 values");
    this.m = [...m];
  }

  static readonly identity = new Mat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /** Swift `m[row, col]`. */
  get(row: number, col: number): number {
    return this.m[col * 4 + row];
  }

  mul(b: Mat4): Mat4 {
    const out = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += this.m[k * 4 + r] * b.m[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return new Mat4(out);
  }

  /** Transforms a point and returns (x, y, z, w) before the perspective divide. */
  apply(p: V3, w = 1): [number, number, number, number] {
    const v = [p.x, p.y, p.z, w];
    const o = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[r] += this.m[k * 4 + r] * v[k];
    return [o[0], o[1], o[2], o[3]];
  }

  /** Perspective for Metal: right-handed view space looking down -Z, depth 0 at near and 1 at far. */
  static perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
    const ys = 1 / Math.tan(fovY / 2), xs = ys / aspect, zs = far / (near - far);
    return new Mat4([xs, 0, 0, 0, 0, ys, 0, 0, 0, 0, zs, -1, 0, 0, zs * near, 0]);
  }

  /** Reversed-Z perspective with an infinite far plane (Section 5.1): near maps to depth 1, infinity to 0. */
  static perspectiveReversedZ(fovY: number, aspect: number, near: number): Mat4 {
    const ys = 1 / Math.tan(fovY / 2), xs = ys / aspect;
    return new Mat4([xs, 0, 0, 0, 0, ys, 0, 0, 0, 0, 0, -1, 0, 0, near, 0]);
  }

  static lookAt(eye: V3, target: V3, up: V3): Mat4 {
    const z = eye.sub(target).normalized;
    const x = up.cross(z).normalized;
    const y = z.cross(x);
    return new Mat4([x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0, -x.dot(eye), -y.dot(eye), -z.dot(eye), 1]);
  }

  /** General inverse (cofactor expansion); undefined when singular. */
  get inverse(): Mat4 | undefined {
    const a = this.m;
    const inv = new Array<number>(16).fill(0);
    inv[0] = a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10];
    inv[4] = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10];
    inv[8] = a[4]*a[9]*a[15] - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9];
    inv[12] = -a[4]*a[9]*a[14] + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9];
    inv[1] = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10];
    inv[5] = a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10];
    inv[9] = -a[0]*a[9]*a[15] + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9];
    inv[13] = a[0]*a[9]*a[14] - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9];
    inv[2] = a[1]*a[6]*a[15] - a[1]*a[7]*a[14] - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7] - a[13]*a[3]*a[6];
    inv[6] = -a[0]*a[6]*a[15] + a[0]*a[7]*a[14] + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7] + a[12]*a[3]*a[6];
    inv[10] = a[0]*a[5]*a[15] - a[0]*a[7]*a[13] - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7] - a[12]*a[3]*a[5];
    inv[14] = -a[0]*a[5]*a[14] + a[0]*a[6]*a[13] + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6] + a[12]*a[2]*a[5];
    inv[3] = -a[1]*a[6]*a[11] + a[1]*a[7]*a[10] + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7] + a[9]*a[3]*a[6];
    inv[7] = a[0]*a[6]*a[11] - a[0]*a[7]*a[10] - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7] - a[8]*a[3]*a[6];
    inv[11] = -a[0]*a[5]*a[11] + a[0]*a[7]*a[9] + a[4]*a[1]*a[11] - a[4]*a[3]*a[9] - a[8]*a[1]*a[7] + a[8]*a[3]*a[5];
    inv[15] = a[0]*a[5]*a[10] - a[0]*a[6]*a[9] - a[4]*a[1]*a[10] + a[4]*a[2]*a[9] + a[8]*a[1]*a[6] - a[8]*a[2]*a[5];
    const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    if (!(Math.abs(det) > 1e-18)) return undefined;
    return new Mat4(inv.map((v) => v / det));
  }
}
