// Port of Zones/Zone.swift. Codable types keep Swift's JSON shape: enums with associated values encode as
// {"case": {label: value}} (unlabeled values as "_0"), so JSON.stringify / JSON.parse round-trip with the iPad app.
import type { FloorPoint, Side } from "../match/court";
import { newUUID } from "../spatial/swiftCompat";
import type { ZoneKey } from "./sceneTimeline";
import { P2 } from "./smartGeometry";

/** Zone geometry in world X, Z (blueprint Section 3.5.1). Angles are radians from the world X axis toward Z. */
export type ZoneGeometry =
  | { rect: { center: FloorPoint; halfWidth: number; halfDepth: number; angle: number } }
  | { circle: { center: FloorPoint; radius: number } }
  | { ellipse: { center: FloorPoint; a: number; b: number; angle: number } }
  /** Simple polygon, counter-clockwise. */
  | { polygon: { _0: FloorPoint[] } }
  /** Closed centripetal Catmull-Rom through the control points. */
  | { freeform: { _0: FloorPoint[] } };

export type ZoneGeometryKind = "rect" | "circle" | "ellipse" | "polygon" | "freeform";

export const ZoneGeometry = {
  rect(center: FloorPoint, halfWidth: number, halfDepth: number, angle: number): ZoneGeometry {
    return { rect: { center, halfWidth, halfDepth, angle } };
  },
  circle(center: FloorPoint, radius: number): ZoneGeometry {
    return { circle: { center, radius } };
  },
  ellipse(center: FloorPoint, a: number, b: number, angle: number): ZoneGeometry {
    return { ellipse: { center, a, b, angle } };
  },
  polygon(points: FloorPoint[]): ZoneGeometry {
    return { polygon: { _0: points } };
  },
  freeform(points: FloorPoint[]): ZoneGeometry {
    return { freeform: { _0: points } };
  },
  /** Which case a geometry is. */
  kind(g: ZoneGeometry): ZoneGeometryKind {
    if ("rect" in g) return "rect";
    if ("circle" in g) return "circle";
    if ("ellipse" in g) return "ellipse";
    if ("polygon" in g) return "polygon";
    return "freeform";
  },
};

export type ZonePattern = "crossHatch" | "diagonal" | "dots" | "glowFill" | "outline";
export const ZonePattern = {
  allCases: ["crossHatch", "diagonal", "dots", "glowFill", "outline"] as readonly ZonePattern[],
};

export type ZoneEdge = "solid" | "dashed";

export type ZoneExtrusion = { flat: Record<string, never> } | { wall: { height: number } } | { cylinder: { height: number } };

export const ZoneExtrusion = {
  flat(): ZoneExtrusion {
    return { flat: {} };
  },
  wall(height: number): ZoneExtrusion {
    return { wall: { height } };
  },
  cylinder(height: number): ZoneExtrusion {
    return { cylinder: { height } };
  },
};

export type ZoneTint = "pink" | "cyan";
export const ZoneTint = { allCases: ["pink", "cyan"] as readonly ZoneTint[] };

export interface ZoneStyle {
  pattern: ZonePattern;
  /** Metres between hatch lines or dot centres. */
  spacing: number;
  /** Metres; the renderer keeps at least one pixel. */
  lineWidth: number;
  angle: number;
  opacity: number;
  edge: ZoneEdge;
  glow: number;
  extrusion: ZoneExtrusion;
  tint: ZoneTint;
}

export const ZoneStyle = {
  create(): ZoneStyle {
    return { pattern: "diagonal", spacing: 0.25, lineWidth: 0.035, angle: Math.PI / 4, opacity: 0.55, edge: "solid", glow: 0.6,
      extrusion: { flat: {} }, tint: "pink" };
  },
};

/** Semantic tags of Section 3.5.6, each with its default style. */
export type ZoneTag = "noFly" | "serveTarget" | "tipAlert" | "freeBall" | "responsibility" | "custom";

const tagTitles: Record<ZoneTag, string> = {
  noFly: "No-Fly Zone",
  serveTarget: "Primary Serve Target",
  tipAlert: "Tip/Dump Alert",
  freeBall: "Free Ball Target",
  responsibility: "Responsibility",
  custom: "Custom",
};

export const ZoneTag = {
  allCases: ["noFly", "serveTarget", "tipAlert", "freeBall", "responsibility", "custom"] as readonly ZoneTag[],

  title(tag: ZoneTag): string {
    return tagTitles[tag];
  },

  defaultStyle(tag: ZoneTag): ZoneStyle {
    const s = ZoneStyle.create();
    switch (tag) {
      case "noFly":
        s.pattern = "crossHatch";
        s.extrusion = ZoneExtrusion.wall(0.5);
        break;
      case "serveTarget":
        s.pattern = "dots";
        s.spacing = 0.3;
        s.extrusion = ZoneExtrusion.cylinder(1.5);
        break;
      case "tipAlert":
        s.pattern = "diagonal";
        s.edge = "dashed";
        s.extrusion = ZoneExtrusion.wall(0.3);
        break;
      case "freeBall":
        s.pattern = "glowFill";
        break;
      case "responsibility":
        s.pattern = "outline";
        s.glow = 0.3;
        break;
      case "custom":
        break;
    }
    return s;
  },
};

export interface ZoneSemantic {
  tag: ZoneTag;
  label: string;
  linked: string[];
}

export const ZoneSemantic = {
  create(tag: ZoneTag, label?: string, linked: string[] = []): ZoneSemantic {
    return { tag, label: label ?? tagTitles[tag], linked };
  },
};

export interface Zone {
  id: string;
  geometry: ZoneGeometry;
  style: ZoneStyle;
  semantic: ZoneSemantic;
  /** Keyframes at later phase markers (Section 3.5.7); `geometry` is the first marker's. */
  keys?: ZoneKey[];
}

export const Zone = {
  create(init: { id?: string; geometry: ZoneGeometry; style?: ZoneStyle; semantic?: ZoneSemantic; keys?: ZoneKey[] }): Zone {
    const semantic = init.semantic ?? ZoneSemantic.create("custom");
    const zone: Zone = { id: init.id ?? newUUID(), geometry: init.geometry, style: init.style ?? ZoneTag.defaultStyle(semantic.tag), semantic };
    if (init.keys !== undefined) zone.keys = init.keys;
    return zone;
  },

  /** The court side of the zone's centroid. */
  side(zone: Zone): Side {
    return Zone.centroid(zone).z >= 0 ? "home" : "opponent";
  },

  centroid(zone: Zone): FloorPoint {
    const g = zone.geometry;
    if ("rect" in g) return g.rect.center;
    if ("circle" in g) return g.circle.center;
    if ("ellipse" in g) return g.ellipse.center;
    const p = "polygon" in g ? g.polygon._0 : g.freeform._0;
    const n = Math.max(p.length, 1);
    return { x: p.reduce((s, q) => s + q.x, 0) / n, z: p.reduce((s, q) => s + q.z, 0) / n };
  },

  /** Signed distance from a world point to the zone boundary: negative inside. */
  distance(zone: Zone, p: FloorPoint): number {
    return ZoneSDF.distance(zone.geometry, p);
  },

  contains(zone: Zone, p: FloorPoint): boolean {
    return Zone.distance(zone, p) <= 0;
  },

  /** The boundary as a closed polygon (exact vertices, or sampled for curves), for snapping and hit tests. */
  outline(zone: Zone): FloorPoint[] {
    return ZoneSDF.outline(zone.geometry);
  },

  translated(zone: Zone, dx: number, dz: number): Zone {
    return { ...zone, geometry: translateGeometry(zone.geometry, dx, dz) };
  },
};

function translateGeometry(g: ZoneGeometry, dx: number, dz: number): ZoneGeometry {
  const t = (p: FloorPoint): FloorPoint => ({ x: p.x + dx, z: p.z + dz });
  if ("rect" in g) return ZoneGeometry.rect(t(g.rect.center), g.rect.halfWidth, g.rect.halfDepth, g.rect.angle);
  if ("circle" in g) return ZoneGeometry.circle(t(g.circle.center), g.circle.radius);
  if ("ellipse" in g) return ZoneGeometry.ellipse(t(g.ellipse.center), g.ellipse.a, g.ellipse.b, g.ellipse.angle);
  if ("polygon" in g) return ZoneGeometry.polygon(g.polygon._0.map(t));
  return ZoneGeometry.freeform(g.freeform._0.map(t));
}

function len2(v: P2): number {
  return v.x * v.x + v.y * v.y;
}

/** Exact signed distance functions of Section 3.5.4 (Quilez), shared with the floor shader. */
export const ZoneSDF = {
  local(p: FloorPoint, c: FloorPoint, angle: number): P2 {
    const dx = p.x - c.x, dz = p.z - c.z;
    const co = Math.cos(angle), si = Math.sin(angle);
    return { x: co * dx + si * dz, y: -si * dx + co * dz };
  },

  box(p: P2, b: P2): number {
    const d = { x: Math.abs(p.x) - b.x, y: Math.abs(p.y) - b.y };
    const outside = { x: Math.max(d.x, 0), y: Math.max(d.y, 0) };
    return Math.sqrt(outside.x * outside.x + outside.y * outside.y) + Math.min(Math.max(d.x, d.y), 0);
  },

  /** Distance to an axis-aligned ellipse with semi-axes ab (Inigo Quilez's closed form). */
  ellipse(point: P2, semiAxes: P2): number {
    if (Math.abs(semiAxes.x - semiAxes.y) < 1e-6) return Math.sqrt(point.x * point.x + point.y * point.y) - semiAxes.x;
    let p = { x: Math.abs(point.x), y: Math.abs(point.y) };
    let ab = semiAxes;
    if (p.x > p.y) {
      p = { x: p.y, y: p.x };
      ab = { x: ab.y, y: ab.x };
    }
    const l = ab.y * ab.y - ab.x * ab.x;
    const m = (ab.x * p.x) / l, m2 = m * m;
    const n = (ab.y * p.y) / l, n2 = n * n;
    const c = (m2 + n2 - 1) / 3, c3 = c * c * c;
    const q = c3 + m2 * n2 * 2;
    const d = c3 + m2 * n2;
    const g = m + m * n2;
    let co: number;
    if (d < 0) {
      const h = Math.acos(Math.max(-1, Math.min(1, q / c3))) / 3;
      const s = Math.cos(h), t = Math.sin(h) * Math.sqrt(3.0);
      const rx = Math.sqrt(Math.max(-c * (s + t + 2) + m2, 0));
      const ry = Math.sqrt(Math.max(-c * (s - t + 2) + m2, 0));
      co = (ry + (l < 0 ? -1 : 1) * rx + Math.abs(g) / Math.max(rx * ry, 1e-12) - m) / 2;
    } else {
      const h = 2 * m * n * Math.sqrt(d);
      const s = (q + h < 0 ? -1.0 : 1.0) * Math.pow(Math.abs(q + h), 1.0 / 3);
      const u = (q - h < 0 ? -1.0 : 1.0) * Math.pow(Math.abs(q - h), 1.0 / 3);
      const rx = -s - u - c * 4 + 2 * m2;
      const ry = (s - u) * Math.sqrt(3.0);
      const rm = Math.sqrt(rx * rx + ry * ry);
      co = (ry / Math.max(Math.sqrt(rm - rx), 1e-12) + (2 * g) / Math.max(rm, 1e-12) - m) / 2;
    }
    co = Math.max(-1, Math.min(1, co));
    const r = { x: ab.x * co, y: ab.y * Math.sqrt(1 - co * co) };
    const dist = Math.sqrt((r.x - p.x) * (r.x - p.x) + (r.y - p.y) * (r.y - p.y));
    return p.y - r.y < 0 ? -dist : dist;
  },

  /** Distance to a simple polygon with the winding sign (negative inside). */
  polygon(p: P2, v: readonly P2[]): number {
    if (v.length < 3) return Infinity;
    let d = len2(P2.sub(p, v[0]));
    let s = 1.0;
    let j = v.length - 1;
    for (let i = 0; i < v.length; i++) {
      const e = P2.sub(v[j], v[i]), w = P2.sub(p, v[i]);
      const t = Math.max(0, Math.min(1, (w.x * e.x + w.y * e.y) / Math.max(e.x * e.x + e.y * e.y, 1e-12)));
      const b = P2.sub(w, P2.scale(e, t));
      d = Math.min(d, len2(b));
      const c1 = p.y >= v[i].y, c2 = p.y < v[j].y, c3 = e.x * w.y > e.y * w.x;
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
      j = i;
    }
    return s * Math.sqrt(d);
  },

  distance(g: ZoneGeometry, p: FloorPoint): number {
    if ("rect" in g) return ZoneSDF.box(ZoneSDF.local(p, g.rect.center, g.rect.angle), { x: g.rect.halfWidth, y: g.rect.halfDepth });
    if ("circle" in g) {
      const c = g.circle.center;
      return Math.sqrt((p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z)) - g.circle.radius;
    }
    if ("ellipse" in g) return ZoneSDF.ellipse(ZoneSDF.local(p, g.ellipse.center, g.ellipse.angle), { x: g.ellipse.a, y: g.ellipse.b });
    if ("polygon" in g) return ZoneSDF.polygon({ x: p.x, y: p.z }, g.polygon._0.map((q) => ({ x: q.x, y: q.z })));
    return ZoneSDF.polygon({ x: p.x, y: p.z }, ZoneSDF.catmullRom(g.freeform._0.map((q) => ({ x: q.x, y: q.z }))));
  },

  /** Closed centripetal Catmull-Rom through the control points, `perSegment` samples per span. */
  catmullRom(c: readonly P2[], perSegment = 12): P2[] {
    const n = c.length;
    if (n < 3) return [...c];
    const out: P2[] = [];
    const knot = (a: P2, b: P2): number => Math.max(Math.pow(len2(P2.sub(b, a)), 0.25), 1e-6); // alpha = 0.5
    for (let i = 0; i < n; i++) {
      const p0 = c[(i - 1 + n) % n], p1 = c[i], p2 = c[(i + 1) % n], p3 = c[(i + 2) % n];
      const t0 = 0.0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
      for (let k = 0; k < perSegment; k++) {
        const t = t1 + ((t2 - t1) * k) / perSegment;
        const a1 = P2.add(P2.scale(p0, (t1 - t) / (t1 - t0)), P2.scale(p1, (t - t0) / (t1 - t0)));
        const a2 = P2.add(P2.scale(p1, (t2 - t) / (t2 - t1)), P2.scale(p2, (t - t1) / (t2 - t1)));
        const a3 = P2.add(P2.scale(p2, (t3 - t) / (t3 - t2)), P2.scale(p3, (t - t2) / (t3 - t2)));
        const b1 = P2.add(P2.scale(a1, (t2 - t) / (t2 - t0)), P2.scale(a2, (t - t0) / (t2 - t0)));
        const b2 = P2.add(P2.scale(a2, (t3 - t) / (t3 - t1)), P2.scale(a3, (t - t1) / (t3 - t1)));
        out.push(P2.add(P2.scale(b1, (t2 - t) / (t2 - t1)), P2.scale(b2, (t - t1) / (t2 - t1))));
      }
    }
    return out;
  },

  outline(g: ZoneGeometry, samples = 64): FloorPoint[] {
    const ring = (f: (a: number) => FloorPoint): FloorPoint[] =>
      Array.from({ length: samples }, (_, i) => f((2 * Math.PI * i) / samples));
    if ("rect" in g) {
      const { center: c, halfWidth: hw, halfDepth: hd, angle: a } = g.rect;
      const co = Math.cos(a), si = Math.sin(a);
      return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as const).map(([u, v]) => ({ x: c.x + co * u - si * v, z: c.z + si * u + co * v }));
    }
    if ("circle" in g) {
      const { center: c, radius: r } = g.circle;
      return ring((t) => ({ x: c.x + r * Math.cos(t), z: c.z + r * Math.sin(t) }));
    }
    if ("ellipse" in g) {
      const { center: c, a, b, angle } = g.ellipse;
      const co = Math.cos(angle), si = Math.sin(angle);
      return ring((t) => {
        const u = a * Math.cos(t), v = b * Math.sin(t);
        return { x: c.x + co * u - si * v, z: c.z + si * u + co * v };
      });
    }
    if ("polygon" in g) return g.polygon._0;
    return ZoneSDF.catmullRom(g.freeform._0.map((q) => ({ x: q.x, y: q.z }))).map((q) => ({ x: q.x, z: q.y }));
  },
};
