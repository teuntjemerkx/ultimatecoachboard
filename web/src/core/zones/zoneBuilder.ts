// Port of Zones/ZoneBuilder.swift: court-aware snapping and stroke-to-zone building (Section 3.5.3).
import type { FloorPoint } from "../match/court";
import { minBy, swiftRound } from "../spatial/swiftCompat";
import { P2, RecognizerParameters, SmartGeometry, type RecognizedShape, type ShapeKind } from "./smartGeometry";
import { Zone, ZoneGeometry, ZoneSemantic, ZoneTag, type ZoneStyle } from "./zone";

/** What a snap attached to, so the canvas can highlight it briefly. */
export type SnapTarget =
  | { kind: "line"; from: FloorPoint; to: FloorPoint }
  | { kind: "point"; point: FloorPoint }
  | { kind: "cell"; min: FloorPoint; max: FloorPoint };

export interface ZoneBuildResult {
  zone: Zone;
  kind: ShapeKind;
  /** The one-tap alternative, when the recognizer was unsure. */
  alternative?: ShapeKind;
  snapped: SnapTarget[];
}

/** Swift `stride(from:through:by:)` on Double (start + i * step, the end included when reached exactly). */
function strideThrough(from: number, through: number, by: number): number[] {
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const v = from + i * by;
    if (v > through) break;
    out.push(v);
  }
  return out;
}

const gridX = strideThrough(-4.5, 4.5, 1.5);
const gridZ = strideThrough(-9.0, 9.0, 1.5);
const crossLines = [-9, -3, 0, 3, 9];
const sideLines = [-4.5, 4.5];

/** Centres of 3 x 3 m zones and 1.5 m sub-cells, and the seams (grid crossings) between them. */
const anchorPoints: FloorPoint[] = (() => {
  const pts: FloorPoint[] = [];
  for (const x of strideThrough(-3.75, 3.75, 1.5)) for (const z of strideThrough(-8.25, 8.25, 1.5)) pts.push({ x, z });
  for (const x of gridX) for (const z of gridZ) pts.push({ x, z });
  for (const x of [-3.0, 0, 3]) for (const z of [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5]) pts.push({ x, z });
  return pts;
})();

const lineIntersections: FloorPoint[] = (() => {
  const pts: FloorPoint[] = [];
  for (const x of [...sideLines, -1.5, 1.5]) for (const z of [...crossLines, -6, 6]) pts.push({ x, z });
  return pts;
})();

function nearestValue(v: number, values: readonly number[], tol: number): number | undefined {
  return minBy(values.filter((x) => Math.abs(x - v) <= tol), (x) => Math.abs(x - v));
}

function nearestPoint(p: FloorPoint, points: readonly FloorPoint[], tol: number): FloorPoint | undefined {
  const near = points.map((q): [FloorPoint, number] => [q, Math.hypot(q.x - p.x, q.z - p.z)]).filter((e) => e[1] <= tol);
  return minBy(near, (e) => e[1])?.[0];
}

/** Court-aware snapping (Section 3.5.3), in world metres. */
export const ZoneSnapping = {
  axisTolerance: (7.0 * Math.PI) / 180,
  lineTolerance: 0.25,
  pointTolerance: 0.3,
  vertexTolerance: 0.2,
  radiusStep: 0.25,

  /** Court lines across the court (constant z) and along it (constant x). */
  crossLines: crossLines as readonly number[],
  sideLines: sideLines as readonly number[],
  /** The 1.5 m grid of zone cells and sub-cells on both halves. */
  gridX: gridX as readonly number[],
  gridZ: gridZ as readonly number[],
  anchorPoints: anchorPoints as readonly FloorPoint[],
  lineIntersections: lineIntersections as readonly FloorPoint[],

  snap(zone: Zone, tokens: readonly FloorPoint[] = [], otherZones: readonly Zone[] = []): [Zone, SnapTarget[]] {
    const z: Zone = { ...zone };
    const hits: SnapTarget[] = [];
    const g = zone.geometry;
    const tol = ZoneSnapping.lineTolerance;
    if ("rect" in g) {
      const c = g.rect.center;
      let a = g.rect.angle, w = g.rect.halfWidth, d = g.rect.halfDepth;
      // Axis alignment within 7 degrees; normalize so the half extents follow the world axes.
      const quarter = Math.PI / 2;
      const k = swiftRound(a / quarter);
      if (Math.abs(a - k * quarter) <= ZoneSnapping.axisTolerance) {
        if (Math.trunc(k) % 2 !== 0) [w, d] = [d, w];
        a = 0;
      }
      let minX = c.x - w, maxX = c.x + w, minZ = c.z - d, maxZ = c.z + d;
      if (a === 0) {
        // A rectangle within 0.25 m of a cell or sub-cell on all sides becomes that cell exactly.
        const x0 = nearestValue(minX, gridX, tol), x1 = nearestValue(maxX, gridX, tol);
        const z0 = nearestValue(minZ, gridZ, tol), z1 = nearestValue(maxZ, gridZ, tol);
        if (x0 !== undefined && x1 !== undefined && z0 !== undefined && z1 !== undefined && x1 > x0 && z1 > z0) {
          [minX, maxX, minZ, maxZ] = [x0, x1, z0, z1];
          hits.push({ kind: "cell", min: { x: x0, z: z0 }, max: { x: x1, z: z1 } });
        } else {
          // Otherwise each edge within 0.25 m of a court line snaps onto it.
          let v = nearestValue(minX, sideLines, tol);
          if (v !== undefined) {
            minX = v;
            hits.push({ kind: "line", from: { x: v, z: -9 }, to: { x: v, z: 9 } });
          }
          v = nearestValue(maxX, sideLines, tol);
          if (v !== undefined) {
            maxX = v;
            hits.push({ kind: "line", from: { x: v, z: -9 }, to: { x: v, z: 9 } });
          }
          v = nearestValue(minZ, crossLines, tol);
          if (v !== undefined) {
            minZ = v;
            hits.push({ kind: "line", from: { x: -4.5, z: v }, to: { x: 4.5, z: v } });
          }
          v = nearestValue(maxZ, crossLines, tol);
          if (v !== undefined) {
            maxZ = v;
            hits.push({ kind: "line", from: { x: -4.5, z: v }, to: { x: 4.5, z: v } });
          }
        }
        z.geometry = ZoneGeometry.rect({ x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 }, (maxX - minX) / 2, (maxZ - minZ) / 2, 0);
      } else {
        z.geometry = ZoneGeometry.rect(c, w, d, a);
      }
    } else if ("circle" in g) {
      const [center, hit] = ZoneSnapping.snapCenter(g.circle.center, tokens);
      if (hit) hits.push(hit);
      z.geometry = ZoneGeometry.circle(center, ZoneSnapping.quantize(g.circle.radius));
    } else if ("ellipse" in g) {
      const [center, hit] = ZoneSnapping.snapCenter(g.ellipse.center, tokens);
      if (hit) hits.push(hit);
      z.geometry = ZoneGeometry.ellipse(center, ZoneSnapping.quantize(g.ellipse.a), ZoneSnapping.quantize(g.ellipse.b), g.ellipse.angle);
    } else if ("polygon" in g) {
      const others = otherZones.flatMap((o) => Zone.outline(o));
      const targets = [...lineIntersections, ...others];
      z.geometry = ZoneGeometry.polygon(g.polygon._0.map((p) => {
        const q = nearestPoint(p, targets, ZoneSnapping.vertexTolerance);
        if (q) {
          hits.push({ kind: "point", point: q });
          return q;
        }
        return p;
      }));
    }
    return [z, hits];
  },

  snapCenter(c: FloorPoint, tokens: readonly FloorPoint[]): [FloorPoint, SnapTarget | undefined] {
    const t = nearestPoint(c, tokens, ZoneSnapping.pointTolerance);
    if (t) return [t, { kind: "point", point: t }];
    const a = nearestPoint(c, anchorPoints, ZoneSnapping.pointTolerance + 0.05);
    if (a) return [a, { kind: "point", point: a }];
    return [c, undefined];
  },

  quantize(r: number): number {
    return Math.max(ZoneSnapping.radiusStep, swiftRound(r / ZoneSnapping.radiusStep) * ZoneSnapping.radiusStep);
  },
};

function diagonal(p: readonly P2[]): number {
  if (p.length === 0) return 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of p) {
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  }
  const dx = maxX - minX, dy = maxY - minY;
  return Math.sqrt(dx * dx + dy * dy);
}

function counterClockwise(v: readonly P2[]): P2[] {
  let area = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area < 0 ? [...v].reverse() : [...v];
}

/** From a stroke on the court to a zone: recognize (Section 3.5.3), build the geometry in world metres, snap. */
export const ZoneBuilder = {
  /**
   * `stroke` is in world metres; `forced` is a shape chosen on the SHAPE row (undefined = AUTO); `snapping` is false
   * while a second finger rests or the Pencil Pro is squeezed.
   */
  build(stroke: readonly FloorPoint[], options: {
    forced?: ShapeKind; tag?: ZoneTag; style?: ZoneStyle; snapping?: boolean; parameters?: RecognizerParameters;
    tokens?: readonly FloorPoint[]; otherZones?: readonly Zone[];
  } = {}): ZoneBuildResult | undefined {
    const tag = options.tag ?? "custom", snapping = options.snapping ?? true;
    const pts = stroke.map((p) => ({ x: p.x, y: p.z }));
    if (pts.length < 3) return undefined;
    const recognized = SmartGeometry.recognize(pts, options.parameters ?? RecognizerParameters.normalHand);
    const kind = options.forced ?? recognized.kind;
    const geometry = ZoneBuilder.geometry(kind, pts, recognized);
    if (!geometry) return undefined;
    let zone = Zone.create({ geometry, style: options.style ?? ZoneTag.defaultStyle(tag), semantic: ZoneSemantic.create(tag) });
    let hits: SnapTarget[] = [];
    if (snapping) [zone, hits] = ZoneSnapping.snap(zone, options.tokens ?? [], options.otherZones ?? []);
    const result: ZoneBuildResult = { zone, kind, snapped: hits };
    const alternative = options.forced === undefined ? recognized.alternative : undefined;
    if (alternative !== undefined) result.alternative = alternative;
    return result;
  },

  /** Geometry for a kind; fits it directly when it is not the recognizer's own winner (SHAPE row, alternative chip). */
  geometry(kind: ShapeKind, pts: readonly P2[], recognized: RecognizedShape): ZoneGeometry | undefined {
    const fp = (p: P2): FloorPoint => ({ x: p.x, z: p.y });
    const own = recognized.kind === kind;
    switch (kind) {
      case "circle": {
        if (own) return ZoneGeometry.circle(fp(recognized.center), recognized.radius);
        const f = SmartGeometry.fitCircle(pts);
        return ZoneGeometry.circle(fp(f.center), f.radius);
      }
      case "ellipse": {
        if (own) return ZoneGeometry.ellipse(fp(recognized.center), recognized.semiAxes.x, recognized.semiAxes.y, recognized.angle);
        const e = SmartGeometry.fitEllipse(pts);
        if (!e) return undefined;
        return ZoneGeometry.ellipse(fp(e.center), e.semiAxes.x, e.semiAxes.y, e.angle);
      }
      case "rect": {
        const corners = own ? recognized.vertices : SmartGeometry.minAreaRect(pts);
        if (corners.length !== 4) return undefined;
        const c = P2.mean(corners, 4);
        const e1 = P2.sub(corners[1], corners[0]), e2 = P2.sub(corners[3], corners[0]);
        const w = Math.sqrt(e1.x * e1.x + e1.y * e1.y) / 2, d = Math.sqrt(e2.x * e2.x + e2.y * e2.y) / 2;
        return ZoneGeometry.rect(fp(c), w, d, Math.atan2(e1.y, e1.x));
      }
      case "polygon": {
        const v = own ? [...recognized.vertices]
          : SmartGeometry.rdp(SmartGeometry.resample(pts, SmartGeometry.sampleCount)[0], 0.04 * diagonal(pts));
        if (v.length > 3) {
          const first = v[0], last = v[v.length - 1];
          const dd = P2.sub(first, last);
          if (dd.x * dd.x + dd.y * dd.y < 1e-6) v.pop();
        }
        if (v.length < 3) return undefined;
        return ZoneGeometry.polygon(counterClockwise(v).map(fp));
      }
      case "freeform": {
        const ring = SmartGeometry.resample(pts, 16)[0];
        return ZoneGeometry.freeform(ring.map(fp));
      }
      case "line":
      case "openPath":
        return undefined;
    }
  },

  diagonal,
  counterClockwise,
};
