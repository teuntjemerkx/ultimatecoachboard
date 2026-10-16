// Port of Geometry/SmartGeometry.swift: the Smart Geometry stroke recognizer (blueprint Section 3.5.3, Appendix D5).
import { copysign, maxBy } from "../spatial/swiftCompat";

/** Swift `P2 = SIMD2<Double>`. */
export interface P2 {
  x: number;
  y: number;
}

export const P2 = {
  zero: { x: 0, y: 0 } as Readonly<P2>,
  of(x: number, y: number): P2 {
    return { x, y };
  },
  add(a: P2, b: P2): P2 {
    return { x: a.x + b.x, y: a.y + b.y };
  },
  sub(a: P2, b: P2): P2 {
    return { x: a.x - b.x, y: a.y - b.y };
  },
  scale(a: P2, s: number): P2 {
    return { x: a.x * s, y: a.y * s };
  },
  div(a: P2, s: number): P2 {
    return { x: a.x / s, y: a.y / s };
  },
  dot(a: P2, b: P2): number {
    return a.x * b.x + a.y * b.y;
  },
  length(a: P2): number {
    return Math.sqrt(a.x * a.x + a.y * a.y);
  },
  /** The sum of points divided by `n` (Swift `reduce(.zero, +) / n`). */
  mean(points: readonly P2[], n = points.length): P2 {
    let x = 0, y = 0;
    for (const p of points) {
      x += p.x;
      y += p.y;
    }
    return { x: x / n, y: y / n };
  },
};

/** Result kinds of the Smart Geometry recognizer. */
export type ShapeKind = "line" | "openPath" | "circle" | "ellipse" | "rect" | "polygon" | "freeform";

export const ShapeKind = {
  allCases: ["line", "openPath", "circle", "ellipse", "rect", "polygon", "freeform"] as readonly ShapeKind[],
};

export interface RecognizedShape {
  kind: ShapeKind;
  /** Offered on the one-tap alternative chip when the runner-up is close. */
  alternative?: ShapeKind;
  center: P2;
  radius: number;
  semiAxes: P2;
  angle: number;
  /** Rectangle corners or polygon vertices, in stroke coordinates. */
  vertices: P2[];
  /** The resampled stroke, kept for freeform and open paths. */
  resampled: P2[];
}

function shape(kind: ShapeKind, fields: Partial<RecognizedShape> = {}): RecognizedShape {
  return { kind, center: P2.zero, radius: 0, semiAxes: P2.zero, angle: 0, vertices: [], resampled: [], ...fields };
}

export interface RecognizerParameters {
  tau: number;
  closeGap: number;
  circleRatio: number;
  prior: number;
  complexity: number;
  ambiguity: number;
}

export const RecognizerParameters = {
  /** Tuned on synthetic strokes, "normal hand" (Appendix D5): 94.7% on the test set. */
  normalHand: { tau: 0.035, closeGap: 0.15, circleRatio: 1.25, prior: 0.008, complexity: 0.002, ambiguity: 0.15 } as Readonly<RecognizerParameters>,
  /** Tuned for a shaky hand: 89.1% on the test set. */
  shakyHand: { tau: 0.045, closeGap: 0.15, circleRatio: 1.4, prior: 0.008, complexity: 0.002, ambiguity: 0.15 } as Readonly<RecognizerParameters>,
};

export interface LineFit {
  center: P2;
  direction: P2;
  rms: number;
}

export interface CircleFit {
  center: P2;
  radius: number;
  rms: number;
}

export interface EllipseFit {
  center: P2;
  /** (major, minor) semi-axes. */
  semiAxes: P2;
  angle: number;
  rms: number;
}

type M3 = number[][];
const zero3 = (): M3 => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

function rms(d: readonly number[]): number {
  if (d.length === 0) return Infinity;
  let s = 0;
  for (const v of d) s += v * v;
  return Math.sqrt(s / d.length);
}

function cross(a: P2, b: P2): number {
  return a.x * b.y - a.y * b.x;
}

function boundingDiagonal(p: readonly P2[]): number {
  let lo = p[0], hi = p[0];
  for (const q of p) {
    lo = { x: Math.min(lo.x, q.x), y: Math.min(lo.y, q.y) };
    hi = { x: Math.max(hi.x, q.x), y: Math.max(hi.y, q.y) };
  }
  return P2.length(P2.sub(hi, lo));
}

function det3(m: M3): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

function invert3(m: M3): M3 | undefined {
  const d = det3(m);
  if (!(Math.abs(d) > 1e-18)) return undefined;
  const inv = zero3();
  inv[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d;
  inv[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d;
  inv[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d;
  inv[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d;
  inv[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d;
  inv[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d;
  inv[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d;
  inv[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d;
  inv[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d;
  return inv;
}

function solve3(a: M3, b: readonly number[]): number[] | undefined {
  const inv = invert3(a);
  if (!inv) return undefined;
  return [0, 1, 2].map((i) => inv[i][0] * b[0] + inv[i][1] * b[1] + inv[i][2] * b[2]);
}

function norm3(v: readonly number[]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/** Real roots of x^3 + a x^2 + b x + c = 0. */
function realCubicRoots(a: number, b: number, c: number): number[] {
  const q = (a * a - 3 * b) / 9;
  const r = (2 * a * a * a - 9 * a * b + 27 * c) / 54;
  const q3 = q * q * q;
  if (r * r < q3) {
    const theta = Math.acos(Math.min(Math.max(r / Math.sqrt(q3), -1), 1));
    const sq = -2 * Math.sqrt(q);
    return [sq * Math.cos(theta / 3) - a / 3,
      sq * Math.cos((theta + 2 * Math.PI) / 3) - a / 3,
      sq * Math.cos((theta - 2 * Math.PI) / 3) - a / 3];
  }
  const aa = -copysign(Math.pow(Math.abs(r) + Math.sqrt(r * r - q3), 1.0 / 3.0), r);
  const bb = aa !== 0 ? q / aa : 0;
  return [aa + bb - a / 3];
}

/**
 * Real eigenvectors of a general 3 x 3 matrix: real roots of the characteristic cubic, each eigenvector taken as the
 * largest cross product of two rows of (M - lambda I).
 */
function realEigenvectors3(m: M3): number[][] {
  const tr = m[0][0] + m[1][1] + m[2][2];
  const minors = (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    + (m[0][0] * m[2][2] - m[0][2] * m[2][0])
    + (m[0][0] * m[1][1] - m[0][1] * m[1][0]);
  const det = det3(m);
  // lambda^3 - tr lambda^2 + minors lambda - det = 0
  const vectors: number[][] = [];
  const crossRows = (x: readonly number[], y: readonly number[]): number[] =>
    [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  for (const lambda of realCubicRoots(-tr, minors, -det)) {
    const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[i][j] - (i === j ? lambda : 0)));
    const options = [crossRows(r[0], r[1]), crossRows(r[0], r[2]), crossRows(r[1], r[2])];
    const best = maxBy(options, norm3);
    if (!best || !(norm3(best) > 1e-30)) continue;
    const n = norm3(best);
    vectors.push(best.map((v) => v / n));
  }
  return vectors;
}

export const SmartGeometry = {
  sampleCount: 64,

  recognize(stroke: readonly P2[], prm: RecognizerParameters = RecognizerParameters.normalHand): RecognizedShape {
    if (stroke.length < 3) return shape("openPath", { resampled: [...stroke] });
    const [p, length] = SmartGeometry.resample(stroke, SmartGeometry.sampleCount);
    const diag = boundingDiagonal(p);
    if (!(length > 0 && diag > 0)) return shape("openPath", { resampled: p });

    if (P2.length(P2.sub(p[p.length - 1], p[0])) / length >= prm.closeGap) {
      const line = SmartGeometry.fitLine(p);
      if (line.rms / diag < 0.03) {
        return shape("line", { center: line.center, angle: Math.atan2(line.direction.y, line.direction.x),
          vertices: [p[0], p[p.length - 1]], resampled: p });
      }
      return shape("openPath", { resampled: p });
    }

    const cornerPoints = SmartGeometry.corners(p);
    const cornered = cornerPoints.length >= 3;
    const circle = SmartGeometry.fitCircle(p);
    const ellipse = SmartGeometry.fitEllipse(p);
    const rect = SmartGeometry.minAreaRect(p);
    const rectRMS = rms(SmartGeometry.distanceToPolyline(p, rect, true));
    const poly = SmartGeometry.polygonVertices(p, diag, cornerPoints);
    const polyRMS = poly ? rms(SmartGeometry.distanceToPolyline(p, poly, true)) : Infinity;
    const ratio = ellipse ? ellipse.semiAxes.x / Math.max(ellipse.semiAxes.y, 1e-9) : 1;

    let candidates: [ShapeKind, number][] = [];
    if (ratio < prm.circleRatio) {
      candidates.push(["circle", circle.rms / diag + 3 * prm.complexity + (cornered ? prm.prior : 0)]);
    } else if (ellipse) {
      candidates.push(["ellipse", ellipse.rms / diag + 5 * prm.complexity + (cornered ? prm.prior : 0)]);
    }
    const polyIsRect = poly ? SmartGeometry.quadIsRect(poly) : false;
    const rectOK = polyIsRect || (poly !== undefined && poly.length === 4 && rectRMS <= 1.6 * polyRMS);
    if (rectOK || poly === undefined) {
      candidates.push(["rect", rectRMS / diag + 5 * prm.complexity + (cornered ? 0 : prm.prior)]);
    }
    if (poly && !(poly.length === 4 && polyIsRect)) {
      candidates.push(["polygon", polyRMS / diag + 2 * poly.length * prm.complexity + (cornered ? 0 : prm.prior)]);
    }
    candidates = candidates.filter((c) => Number.isFinite(c[1])).sort((a, b) => a[1] - b[1]);

    const best = candidates[0];
    if (!best || !(best[1] <= prm.tau)) {
      const alt = best && best[1] < 1.4 * prm.tau ? best[0] : undefined;
      return shape("freeform", { alternative: alt, resampled: p });
    }
    let alternative: ShapeKind | undefined;
    if (candidates.length > 1 && candidates[1][1] - best[1] < prm.ambiguity * best[1]) {
      alternative = candidates[1][0];
    } else if (best[1] > 0.85 * prm.tau) {
      alternative = "freeform";
    }

    const out = shape(best[0], { alternative, resampled: p });
    switch (best[0]) {
      case "circle":
        out.center = circle.center;
        out.radius = circle.radius;
        break;
      case "ellipse":
        if (ellipse) {
          out.center = ellipse.center;
          out.semiAxes = ellipse.semiAxes;
          out.angle = ellipse.angle;
        }
        break;
      case "rect": {
        out.vertices = rect;
        out.center = P2.mean(rect, 4);
        const edge = P2.sub(rect[1], rect[0]);
        out.angle = Math.atan2(edge.y, edge.x);
        break;
      }
      case "polygon":
        out.vertices = poly ?? [];
        out.center = P2.mean(out.vertices, Math.max(out.vertices.length, 1));
        break;
      default:
        break;
    }
    return out;
  },

  // Preprocessing

  resample(pts: readonly P2[], n: number): [P2[], number] {
    if (pts.length < 2 || n < 2) return [[...pts], 0];
    const cumulative: number[] = [0];
    for (let i = 1; i < pts.length; i++) cumulative.push(cumulative[i - 1] + P2.length(P2.sub(pts[i], pts[i - 1])));
    const total = cumulative[cumulative.length - 1];
    if (!(total > 0)) return [Array.from({ length: n }, () => pts[0]), 0];
    const out: P2[] = [];
    let j = 0;
    for (let k = 0; k < n; k++) {
      const t = (total * k) / (n - 1);
      while (j < pts.length - 2 && cumulative[j + 1] < t) j += 1;
      const segment = cumulative[j + 1] - cumulative[j];
      const u = segment > 0 ? (t - cumulative[j]) / segment : 0;
      out.push(P2.add(pts[j], P2.scale(P2.sub(pts[j + 1], pts[j]), Math.min(Math.max(u, 0), 1))));
    }
    return [out, total];
  },

  boundingDiagonal,
  rms,
  cross,

  distanceToPolyline(p: readonly P2[], poly: readonly P2[], closed: boolean): number[] {
    if (poly.length < 2) return p.map(() => Infinity);
    const path = closed ? [...poly, poly[0]] : poly;
    return p.map((q) => {
      let best = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const ab = P2.sub(b, a);
        const l2 = P2.dot(ab, ab);
        const t = l2 > 0 ? Math.min(Math.max(P2.dot(P2.sub(q, a), ab) / l2, 0), 1) : 0;
        best = Math.min(best, P2.length(P2.sub(q, P2.add(a, P2.scale(ab, t)))));
      }
      return best;
    });
  },

  // Corners (ring-contrast test)

  corners(p: readonly P2[], w = 3, minAngle = 45, contrast = 2.0): P2[] {
    const q = [...p];
    if (q.length > 1 && P2.length(P2.sub(q[0], q[q.length - 1])) < 1e-12) q.pop();
    const n = q.length;
    if (!(n > 2 * (w + 8))) return [];
    const at = (i: number): P2 => q[((i % n) + n) % n];
    const angle: number[] = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const a = P2.sub(q[i], at(i - w));
      const b = P2.sub(at(i + w), q[i]);
      angle[i] = (Math.abs(Math.atan2(cross(a, b), P2.dot(a, b))) * 180) / Math.PI;
    }
    const ang = (i: number): number => angle[((i % n) + n) % n];
    const found: number[] = [];
    for (let i = 0; i < n; i++) {
      if (angle[i] < minAngle || angle[i] < ang(i - 1) || angle[i] < ang(i + 1)) continue;
      const ring: number[] = [];
      for (let s = w + 2; s <= w + 7; s++) ring.push(ang(i + s));
      for (let s = -w - 7; s <= -w - 2; s++) ring.push(ang(i + s));
      const mean = ring.reduce((x, y) => x + y, 0) / ring.length;
      if (angle[i] >= contrast * (mean + 1e-6)) found.push(i);
    }
    const merged: number[] = [];
    for (const i of found) {
      const last = merged[merged.length - 1];
      if (last !== undefined && i - last <= w) {
        if (angle[i] > angle[last]) merged[merged.length - 1] = i;
      } else {
        merged.push(i);
      }
    }
    if (merged.length > 1 && merged[0] + n - merged[merged.length - 1] <= w) merged.shift();
    return merged.map((i) => q[i]);
  },

  // Fits

  fitLine(p: readonly P2[]): LineFit {
    const c = P2.mean(p);
    let sxx = 0, sxy = 0, syy = 0;
    for (const q of p) {
      const d = P2.sub(q, c);
      sxx += d.x * d.x;
      sxy += d.x * d.y;
      syy += d.y * d.y;
    }
    // Principal direction of the 2 x 2 scatter matrix.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const u = { x: Math.cos(theta), y: Math.sin(theta) };
    const normal = { x: -u.y, y: u.x };
    const r = rms(p.map((q) => Math.abs(P2.dot(P2.sub(q, c), normal))));
    return { center: c, direction: u, rms: r };
  },

  /** Kasa algebraic fit refined by Gauss-Newton on the geometric error. */
  fitCircle(p: readonly P2[]): CircleFit {
    // Normal equations for [2x 2y 1] * [cx cy k] = x^2 + y^2.
    const ata = zero3();
    const atb = [0, 0, 0];
    for (const q of p) {
      const row = [2 * q.x, 2 * q.y, 1.0];
      const rhs = q.x * q.x + q.y * q.y;
      for (let i = 0; i < 3; i++) {
        atb[i] += row[i] * rhs;
        for (let j = 0; j < 3; j++) ata[i][j] += row[i] * row[j];
      }
    }
    let center: P2 = P2.zero;
    let radius = 0;
    const x = solve3(ata, atb);
    if (x) {
      center = { x: x[0], y: x[1] };
      radius = Math.sqrt(Math.max(x[2] + P2.dot(center, center), 0));
    } else {
      center = P2.mean(p);
      const c0 = center;
      radius = p.map((q) => P2.length(P2.sub(q, c0))).reduce((s, v) => s + v, 0) / p.length;
    }
    // Gauss-Newton refinement: residual r_i = |p_i - c| - R.
    for (let iter = 0; iter < 10; iter++) {
      const jtj = zero3();
      const jtr = [0, 0, 0];
      for (const q of p) {
        const d = P2.sub(q, center);
        const len = Math.max(P2.length(d), 1e-12);
        const r = len - radius;
        const jrow = [-d.x / len, -d.y / len, -1.0];
        for (let i = 0; i < 3; i++) {
          jtr[i] += jrow[i] * r;
          for (let j = 0; j < 3; j++) jtj[i][j] += jrow[i] * jrow[j];
        }
      }
      for (let i = 0; i < 3; i++) jtj[i][i] *= 1.0 + 1e-6;
      const step = solve3(jtj, jtr.map((v) => -v));
      if (!step) break;
      center = { x: center.x + step[0], y: center.y + step[1] };
      radius += step[2];
      if (Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) < 1e-10) break;
    }
    radius = Math.abs(radius);
    const c = center;
    const residuals = p.map((q) => Math.abs(P2.length(P2.sub(q, c)) - radius));
    return { center, radius, rms: rms(residuals) };
  },

  /** Direct least-squares ellipse fit (Fitzgibbon; numerically stable form of Halir and Flusser). */
  fitEllipse(p: readonly P2[]): EllipseFit | undefined {
    const m = P2.mean(p);
    let s = 0;
    for (const q of p) s = Math.max(s, Math.abs(q.x - m.x), Math.abs(q.y - m.y));
    if (!(s > 0)) return undefined;
    const s1 = zero3(), s2 = zero3(), s3 = zero3();
    for (const q0 of p) {
      const q = P2.div(P2.sub(q0, m), s);
      const d1 = [q.x * q.x, q.x * q.y, q.y * q.y];
      const d2 = [q.x, q.y, 1.0];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          s1[i][j] += d1[i] * d1[j];
          s2[i][j] += d1[i] * d2[j];
          s3[i][j] += d2[i] * d2[j];
        }
      }
    }
    const s3inv = invert3(s3);
    if (!s3inv) return undefined;
    // T = -S3^-1 * S2^T
    const t = zero3();
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let acc = 0;
        for (let k = 0; k < 3; k++) acc += s3inv[i][k] * s2[j][k];
        t[i][j] = -acc;
      }
    }
    // M = S1 + S2 * T, then premultiply by C1^-1.
    const mm = s1.map((row) => [...row]);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let acc = 0;
        for (let k = 0; k < 3; k++) acc += s2[i][k] * t[k][j];
        mm[i][j] += acc;
      }
    }
    const mc: M3 = [mm[2].map((v) => v / 2), mm[1].map((v) => -v), mm[0].map((v) => v / 2)];
    let chosen: number[] | undefined;
    let bestCond = 0;
    for (const v of realEigenvectors3(mc)) {
      const cond = 4 * v[0] * v[2] - v[1] * v[1];
      if (cond > bestCond) {
        bestCond = cond;
        chosen = v;
      }
    }
    if (!chosen) return undefined;
    const a = chosen[0], b = chosen[1], c = chosen[2];
    const d = t[0][0] * a + t[0][1] * b + t[0][2] * c;
    const e = t[1][0] * a + t[1][1] * b + t[1][2] * c;
    const f = t[2][0] * a + t[2][1] * b + t[2][2] * c;
    const den = b * b - 4 * a * c;
    if (!(Math.abs(den) > 1e-15)) return undefined;
    const x0 = (2 * c * d - b * e) / den;
    const y0 = (2 * a * e - b * d) / den;
    const num = 2 * (a * e * e + c * d * d - b * d * e + den * f);
    const root = Math.sqrt((a - c) * (a - c) + b * b);
    const ax1 = Math.sqrt(Math.max(num * (a + c + root), 0)) / Math.abs(den);
    const ax2 = Math.sqrt(Math.max(num * (a + c - root), 0)) / Math.abs(den);
    const angle = 0.5 * Math.atan2(-b, c - a);
    const center = P2.add(P2.scale({ x: x0, y: y0 }, s), m);
    const big = ax1 * s, small = ax2 * s;
    if (!(Number.isFinite(big) && Number.isFinite(small) && big > 0 && small > 0)) return undefined;
    // Residual against a dense polyline of the fitted ellipse.
    const outline: P2[] = [];
    for (let k = 0; k < 256; k++) {
      const tt = (2 * Math.PI * k) / 256;
      const local = { x: big * Math.cos(tt), y: small * Math.sin(tt) };
      outline.push(P2.add({ x: Math.cos(angle) * local.x - Math.sin(angle) * local.y,
        y: Math.sin(angle) * local.x + Math.cos(angle) * local.y }, center));
    }
    const r = rms(SmartGeometry.distanceToPolyline(p, outline, true));
    // `angle` is the direction of the first computed axis; report the major axis direction.
    const majorAngle = big >= small ? angle : angle + Math.PI / 2;
    return { center, semiAxes: { x: Math.max(big, small), y: Math.min(big, small) }, angle: majorAngle, rms: r };
  },

  /** Minimum-area enclosing rectangle via the convex hull and rotating edges. */
  minAreaRect(p: readonly P2[]): P2[] {
    const hull = SmartGeometry.convexHull(p);
    if (hull.length < 3) {
      const c = P2.mean(p, Math.max(p.length, 1));
      return [c, c, c, c];
    }
    let best: { area: number; theta: number; lo: P2; hi: P2 } | undefined;
    for (let i = 0; i < hull.length; i++) {
      const e = P2.sub(hull[(i + 1) % hull.length], hull[i]);
      const th = Math.atan2(e.y, e.x);
      const cs = Math.cos(th), sn = Math.sin(th);
      let lo = { x: Infinity, y: Infinity };
      let hi = { x: -Infinity, y: -Infinity };
      for (const h of hull) {
        const q = { x: cs * h.x + sn * h.y, y: -sn * h.x + cs * h.y };
        lo = { x: Math.min(lo.x, q.x), y: Math.min(lo.y, q.y) };
        hi = { x: Math.max(hi.x, q.x), y: Math.max(hi.y, q.y) };
      }
      const area = (hi.x - lo.x) * (hi.y - lo.y);
      if (best === undefined || area < best.area) best = { area, theta: th, lo, hi };
    }
    const b = best!;
    const cs = Math.cos(b.theta), sn = Math.sin(b.theta);
    const local = [{ x: b.lo.x, y: b.lo.y }, { x: b.hi.x, y: b.lo.y }, { x: b.hi.x, y: b.hi.y }, { x: b.lo.x, y: b.hi.y }];
    return local.map((v) => ({ x: cs * v.x - sn * v.y, y: sn * v.x + cs * v.y }));
  },

  /** Andrew's monotone chain; counter-clockwise, no repeated end point. */
  convexHull(points: readonly P2[]): P2[] {
    const pts = [...points].sort((a, b) => (a.x === b.x ? (a.y < b.y ? -1 : a.y > b.y ? 1 : 0) : a.x < b.x ? -1 : 1));
    if (pts.length <= 2) return pts;
    const lower: P2[] = [];
    for (const q of pts) {
      while (lower.length >= 2 && cross(P2.sub(lower[lower.length - 1], lower[lower.length - 2]), P2.sub(q, lower[lower.length - 2])) <= 0) {
        lower.pop();
      }
      lower.push(q);
    }
    const upper: P2[] = [];
    for (const q of [...pts].reverse()) {
      while (upper.length >= 2 && cross(P2.sub(upper[upper.length - 1], upper[upper.length - 2]), P2.sub(q, upper[upper.length - 2])) <= 0) {
        upper.pop();
      }
      upper.push(q);
    }
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
  },

  /** Ramer-Douglas-Peucker simplification of an open polyline. */
  rdp(p: readonly P2[], epsilon: number): P2[] {
    if (p.length < 3) return [...p];
    const a = p[0], b = p[p.length - 1];
    const ab = P2.sub(b, a);
    const len = P2.length(ab);
    let maxD = -1.0;
    let index = 0;
    for (let i = 1; i < p.length - 1; i++) {
      const d = len > 0 ? Math.abs(cross(ab, P2.sub(p[i], a))) / len : P2.length(P2.sub(p[i], a));
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > epsilon) {
      const left = SmartGeometry.rdp(p.slice(0, index + 1), epsilon);
      const right = SmartGeometry.rdp(p.slice(index), epsilon);
      return [...left.slice(0, -1), ...right];
    }
    return [a, b];
  },

  /** Union of detected corners and RDP vertices, ordered around the centroid, merged and pruned. */
  polygonVertices(p: readonly P2[], diag: number, cs: readonly P2[], epsilon = 0.04, merge = 0.08, maxCount = 6): P2[] | undefined {
    const simplified = SmartGeometry.rdp([...p, p[0]], epsilon * diag).slice(0, -1);
    const centroid = P2.mean(p);
    const key = (v: P2): number => Math.atan2(v.y - centroid.y, v.x - centroid.x);
    const candidates = [...cs, ...simplified].sort((a, b) => {
      const ka = key(a), kb = key(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    let out: P2[] = [];
    for (const v of candidates) {
      const last = out[out.length - 1];
      if (last === undefined || P2.length(P2.sub(v, last)) > merge * diag) out.push(v);
    }
    if (out.length > 2 && P2.length(P2.sub(out[0], out[out.length - 1])) < merge * diag) out.pop();
    let changed = true;
    while (changed && out.length > 3) {
      changed = false;
      for (let i = 0; i < out.length; i++) {
        const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
        const u = P2.sub(b, a), v = P2.sub(c, b);
        const turn = (Math.abs(Math.atan2(cross(u, v), P2.dot(u, v))) * 180) / Math.PI;
        if (turn < 15) {
          out = [...out.slice(0, i), ...out.slice(i + 1)];
          changed = true;
          break;
        }
      }
    }
    return out.length >= 3 && out.length <= maxCount ? out : undefined;
  },

  quadIsRect(poly: readonly P2[], tolerance = 15): boolean {
    if (poly.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      const u = P2.sub(poly[(i + 3) % 4], poly[i]);
      const v = P2.sub(poly[(i + 1) % 4], poly[i]);
      const denom = P2.length(u) * P2.length(v);
      if (!(denom > 0)) return false;
      const deg = (Math.acos(Math.min(Math.max(P2.dot(u, v) / denom, -1), 1)) * 180) / Math.PI;
      if (Math.abs(deg - 90) > tolerance) return false;
    }
    return true;
  },

  // Small linear algebra (exposed for tests)
  det3,
  invert3,
  solve3,
  realEigenvectors3,
  norm3,
  realCubicRoots,
};
