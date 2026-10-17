import * as THREE from "three";
import type { FloorPoint } from "../../core/match/court";
import type { InkStroke } from "../../core/match/liveTypes";
import { AvatarMaterial, AvatarMesh, BallFlight, BodyMetrics, Joint, PlayerBodies, SkeletonModel, V3, type PosedPlayer } from "../../core/spatial";
import { Zone, type SnapTarget } from "../../core/zones";
import { Athlete, loadAthletes, type AthleteTemplate } from "./athletes";
import type { Board3D, BoardColors } from "./Board3D";

/** What the Studio shows on the 3D board for one moment of the scene. */
export interface Players3DInput {
  players: PosedPlayer[];
  colors: BoardColors;
  selected?: string;
  ball?: { x: number; y: number; z: number };
  zones: Zone[];
  selectedZone?: string;
  ink: InkStroke[];
  /** A stroke being drawn (pen or zone tool). */
  stroke?: { points: FloorPoint[]; zone: boolean; tint: string };
  /** Sight lines (Section 5.6): eye to target; dashed and red when less than half visible. */
  gaze?: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; visible: boolean }[];
  /** What a drop or a zone just snapped to (court lines, spots, cells), shown briefly. */
  highlights?: SnapTarget[];
  /** The ball's solved flights, as points in the air. */
  ballPaths?: { x: number; y: number; z: number }[][];
}

type RestBuffers = ReturnType<AvatarMesh["buffers"]>;

/** One avatar mesh per stature (to the millimetre): building it is the expensive part. */
const meshCache = new Map<number, RestBuffers>();

function restBuffers(stature: number): RestBuffers {
  const key = Math.round(stature * 1000);
  let b = meshCache.get(key);
  if (!b) {
    b = new AvatarMesh(new SkeletonModel(new BodyMetrics(stature))).buffers();
    meshCache.set(key, b);
  }
  return b;
}

/** A theme colour that Board3D does not carry, read from the CSS variables applyTheme wrote. */
export function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--c-${name}`).trim() || fallback;
}

/**
 * CPU dual-quaternion skinning (Kavan et al.) of a rest mesh into position and normal arrays. `dq` holds per joint
 * the real part (x, y, z, w) then the dual part (x, y, z, w) of its skin transform (posed * inverse(rest)).
 */
function skin(rest: RestBuffers, dq: Float64Array, pos: Float32Array, nrm: Float32Array) {
  const { positions: P, normals: N, joints: J, weights: W } = rest;
  const n = P.length / 3;
  for (let i = 0; i < n; i++) {
    const a = J[2 * i] * 8, b = J[2 * i + 1] * 8;
    const w0 = W[2 * i];
    let w1 = W[2 * i + 1];
    if (dq[a] * dq[b] + dq[a + 1] * dq[b + 1] + dq[a + 2] * dq[b + 2] + dq[a + 3] * dq[b + 3] < 0) w1 = -w1;
    let rx = w0 * dq[a] + w1 * dq[b], ry = w0 * dq[a + 1] + w1 * dq[b + 1];
    let rz = w0 * dq[a + 2] + w1 * dq[b + 2], rw = w0 * dq[a + 3] + w1 * dq[b + 3];
    let dx = w0 * dq[a + 4] + w1 * dq[b + 4], dy = w0 * dq[a + 5] + w1 * dq[b + 5];
    let dz = w0 * dq[a + 6] + w1 * dq[b + 6], dw = w0 * dq[a + 7] + w1 * dq[b + 7];
    const len = Math.hypot(rx, ry, rz, rw) || 1;
    rx /= len; ry /= len; rz /= len; rw /= len;
    dx /= len; dy /= len; dz /= len; dw /= len;
    // Translation: the vector part of 2 * dual * conjugate(real).
    const tx = 2 * (-dw * rx + dx * rw - dy * rz + dz * ry);
    const ty = 2 * (-dw * ry + dx * rz + dy * rw - dz * rx);
    const tz = 2 * (-dw * rz - dx * ry + dy * rx + dz * rw);
    // Rotation: v' = v + w c + u x c, with c = 2 (u x v); positions also translate.
    let px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
    let cx = 2 * (ry * pz - rz * py), cy = 2 * (rz * px - rx * pz), cz = 2 * (rx * py - ry * px);
    pos[3 * i] = px + rw * cx + (ry * cz - rz * cy) + tx;
    pos[3 * i + 1] = py + rw * cy + (rz * cx - rx * cz) + ty;
    pos[3 * i + 2] = pz + rw * cz + (rx * cy - ry * cx) + tz;
    px = N[3 * i]; py = N[3 * i + 1]; pz = N[3 * i + 2];
    cx = 2 * (ry * pz - rz * py); cy = 2 * (rz * px - rx * pz); cz = 2 * (rx * py - ry * px);
    nrm[3 * i] = px + rw * cx + (ry * cz - rz * cy);
    nrm[3 * i + 1] = py + rw * cy + (rz * cx - rx * cz);
    nrm[3 * i + 2] = pz + rw * cz + (rx * cy - ry * cx);
  }
}

interface Avatar {
  stature: number;
  /** The real athlete, once the models are loaded; until then (or if they cannot load) the drawn mannequin. */
  athlete?: Athlete;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  colorKey: string;
  label: THREE.Sprite;
  labelText: string;
  ring: THREE.Mesh;
  /** Shirt numbers on the chest and the back, when the label is a number. */
  numbers?: { key: string; front: THREE.Mesh; back: THREE.Mesh };
}

const labelTextures = new Map<string, THREE.CanvasTexture>();

/** A label above a player's head, drawn once per text and colour into a canvas. */
function labelTexture(text: string, color: string, fill: string): THREE.CanvasTexture {
  const key = `${text}|${color}|${fill}`;
  let t = labelTextures.get(key);
  if (t) return t;
  const cv = document.createElement("canvas");
  const h = 96;
  const g = cv.getContext("2d")!;
  g.font = `800 ${h * 0.62}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const w = Math.max(h, Math.ceil(g.measureText(text).width + h * 0.5));
  cv.width = w;
  cv.height = h;
  g.font = `800 ${h * 0.62}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  g.fillStyle = fill;
  g.strokeStyle = color;
  g.lineWidth = 7;
  const r = h / 2 - 5;
  g.beginPath();
  g.roundRect(4, 4, w - 8, h - 8, r);
  g.fill();
  g.stroke();
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 3);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  labelTextures.set(key, t);
  return t;
}

/** Skin tones and hair colours the athletes get (multiplying their textures), picked per player so a team varies. */
const skinTones = ["#FFFFFF", "#F1D6C2", "#D9B08C", "#B98563", "#8A5A3C", "#5E3B27"];
const hairColours = ["#FFFFFF", "#7A5233", "#3B2618", "#1E1410", "#C8A06A", "#5A3A22"];

/** A stable small number from a player's id. */
function hashOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

const numberTextures = new Map<string, THREE.CanvasTexture>();

/** A shirt number in athletic lettering on a transparent canvas. */
function numberTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  let t = numberTextures.get(key);
  if (t) return t;
  const cv = document.createElement("canvas");
  const h = 128;
  const g = cv.getContext("2d")!;
  const font = `800 ${h * 0.95}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  g.font = font;
  cv.width = Math.ceil(g.measureText(text).width + 8);
  cv.height = h;
  g.font = font;
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, cv.width / 2, h / 2 + 6);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  numberTextures.set(key, t);
  return t;
}

/** A ribbon lying on the floor along a polyline, `width` metres wide, lifted `lift` metres against z-fighting. */
function ribbon(points: readonly FloorPoint[], width: number, lift: number, closed = false): THREE.BufferGeometry | null {
  const pts = closed && points.length > 2 ? [...points, points[0]] : [...points];
  if (pts.length < 2) return null;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const nx = -dz * (width / 2), nz = dx * (width / 2);
    verts.push(pts[i].x + nx, lift, pts[i].z + nz, pts[i].x - nx, lift, pts[i].z - nz);
    if (i > 0) {
      const a = 2 * (i - 1);
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  return g;
}

const patternTextures = new Map<string, THREE.CanvasTexture>();

/** One cell of a zone fill pattern, white on transparent (the material tints it), repeated in world metres. */
function patternTexture(pattern: string): THREE.CanvasTexture | undefined {
  if (pattern !== "diagonal" && pattern !== "crossHatch" && pattern !== "dots") return undefined;
  let t = patternTextures.get(pattern);
  if (t) return t;
  const n = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const g = cv.getContext("2d")!;
  g.fillStyle = g.strokeStyle = "#FFFFFF";
  g.lineWidth = 10;
  if (pattern === "dots") {
    g.beginPath();
    g.arc(n / 2, n / 2, 10, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillRect(0, 0, 5, n);
    g.fillRect(n - 5, 0, 5, n);
    if (pattern === "crossHatch") {
      g.fillRect(0, 0, n, 5);
      g.fillRect(0, n - 5, n, 5);
    }
  }
  t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  patternTextures.set(pattern, t);
  return t;
}

/**
 * The Studio's players on the 3D board (Section 3.2): dual-quaternion skinned avatars in team colours with a label
 * over the head and a ring on the floor, the ball, zones and ink on the floor, and sight lines. Rebuilt only when
 * the Studio hands it a new moment of the scene.
 */
export class Players3D {
  private avatars = new Map<string, Avatar>();
  private overlay = new THREE.Group();
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private posed: PosedPlayer[] = [];
  /** The eye-view player: their avatar and label are hidden once the camera is in their head. */
  private hidden?: string;
  private athletes?: { female: AthleteTemplate; male: AthleteTemplate };
  private last?: Players3DInput;
  private disposed = false;

  constructor(private board: Board3D) {
    loadAthletes().then((t) => {
      if (this.disposed) return;
      this.athletes = t;
      if (this.last) this.update(this.last);
    }).catch(() => {
      // Offline before the models were cached: the mannequins stay, and bodies are kept apart as mannequins.
      PlayerBodies.athletes = false;
    });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BallFlight.radius, 24, 16), new THREE.MeshLambertMaterial({ color: "#F2B705" }));
    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24),
      new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.22, depthWrite: false }));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ball.visible = this.ballShadow.visible = false;
    board.dynamic.add(this.overlay, this.ball, this.ballShadow);
  }

  dispose() {
    this.disposed = true;
    for (const a of this.avatars.values()) this.removeAvatar(a);
    this.avatars.clear();
    this.clearOverlay();
    this.board.dynamic.remove(this.overlay, this.ball, this.ballShadow);
  }

  update(input: Players3DInput) {
    this.last = input;
    this.posed = input.players;
    const seen = new Set<string>();
    const jersey = { home: input.colors.home, opponent: input.colors.opponent };
    const libero = cssColor("libero", "#F5F5F5");
    const led = cssColor("led", "#2D7DFF");
    const labelInk = cssColor("tokenLabel", "#0A1A33");
    const labelFill = cssColor("surface", "#FFFFFF");
    for (const p of input.players) {
      seen.add(p.id);
      const stature = p.skeleton.metrics.stature;
      const team = p.token.role === "L" ? libero : jersey[p.token.side];
      const colorKey = [team, input.colors.skin, input.colors.shorts, input.colors.pads, input.colors.shoes, input.colors.hair].join();
      let a = this.avatars.get(p.id);
      if (a && Math.abs(a.stature - stature) > 5e-4) {
        this.removeAvatar(a);
        a = undefined;
      }
      if (!a) a = this.addAvatar(p.id, stature);
      const template = this.athletes ? (PlayerBodies.women ? this.athletes.female : this.athletes.male) : undefined;
      if (a.athlete && a.athlete.template !== template) {
        a.athlete.dispose();
        a.athlete = undefined;
      }
      if (template && !a.athlete) {
        a.athlete = new Athlete(template);
        this.board.dynamic.add(a.athlete.root);
        a.mesh.visible = false;
      }
      if (a.athlete) {
        const h = hashOf(p.id);
        a.athlete.setColors({ jersey: team, shorts: input.colors.shorts, skin: skinTones[h % skinTones.length],
          hair: hairColours[(h >>> 8) % hairColours.length] });
        a.athlete.pose(p);
      } else {
        if (a.colorKey !== colorKey) this.paint(a, team, input.colors, colorKey);
        // Skin into the mesh.
        const dqs = p.skeleton.skin(p.joints);
        const dq = new Float64Array(dqs.length * 8);
        dqs.forEach((d, j) => dq.set([d.real.x, d.real.y, d.real.z, d.real.w, d.dual.x, d.dual.y, d.dual.z, d.dual.w], j * 8));
        const pos = a.geometry.getAttribute("position") as THREE.BufferAttribute;
        const nrm = a.geometry.getAttribute("normal") as THREE.BufferAttribute;
        skin(restBuffers(stature), dq, pos.array as Float32Array, nrm.array as Float32Array);
        pos.needsUpdate = nrm.needsUpdate = true;
        a.geometry.computeBoundingSphere();
      }
      // Label over the head, ring on the floor under the pelvis.
      const selected = input.selected === p.id;
      if (a.labelText !== `${p.token.label}|${selected}|${labelInk}|${labelFill}|${led}`) {
        a.labelText = `${p.token.label}|${selected}|${labelInk}|${labelFill}|${led}`;
        const tex = labelTexture(p.token.label, selected ? labelFill : labelInk, selected ? led : labelFill);
        (a.label.material as THREE.SpriteMaterial).map = tex;
        (a.label.material as THREE.SpriteMaterial).needsUpdate = true;
        const img = tex.image as HTMLCanvasElement;
        a.label.scale.set((0.045 * img.width) / img.height, 0.045, 1);
      }
      const head = p.headCentre;
      a.label.position.set(head.x, head.y + 0.32, head.z);
      const pelvis = p.joints[Joint.pelvis].translation;
      a.ring.position.set(pelvis.x, 0.012, pelvis.z);
      a.ring.scale.setScalar(selected ? 1.25 : 1);
      (a.ring.material as THREE.MeshBasicMaterial).color.set(selected ? led : jersey[p.token.side]);
      this.placeNumbers(a, p, team);
    }
    for (const [id, a] of this.avatars) if (!seen.has(id)) { this.removeAvatar(a); this.avatars.delete(id); }
    this.applyHidden();

    if (input.ball) {
      this.ball.visible = this.ballShadow.visible = true;
      this.ball.position.set(input.ball.x, input.ball.y, input.ball.z);
      this.ballShadow.position.set(input.ball.x, 0.008, input.ball.z);
      (this.ball.material as THREE.MeshLambertMaterial).color.set(input.colors.ball);
    } else this.ball.visible = this.ballShadow.visible = false;

    this.clearOverlay();
    const zoneA = cssColor("zoneA", input.colors.home), zoneB = cssColor("zoneB", input.colors.opponent);
    const tint = (t: string) => (t === "pink" ? zoneA : zoneB);
    input.zones.forEach((z, i) => this.addZone(z, tint(z.style.tint), input.selectedZone === z.id, led, 0.004 + i * 0.0005));
    const ink = cssColor("ink", "#7C3AED");
    for (const s of input.ink) this.addRibbon(s.points, Math.max(0.05, s.width), ink, 0.02);
    if (input.stroke && input.stroke.points.length > 1) {
      this.addRibbon(input.stroke.points, 0.07, input.stroke.zone ? tint(input.stroke.tint) : ink, 0.022);
    }
    for (const g of input.gaze ?? []) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(g.from.x, g.from.y, g.from.z), new THREE.Vector3(g.to.x, g.to.y, g.to.z)]);
      const mat = g.visible
        ? new THREE.LineBasicMaterial({ color: cssColor("text", "#0A1A33"), transparent: true, opacity: 0.85 })
        : new THREE.LineDashedMaterial({ color: "#FF3B1A", dashSize: 0.15, gapSize: 0.1 });
      const line = new THREE.Line(geo, mat);
      if (!g.visible) line.computeLineDistances();
      this.overlay.add(line);
    }
    for (const h of input.highlights ?? []) {
      if (h.kind === "line") this.addRibbon([h.from, h.to], 0.06, led, 0.026);
      else if (h.kind === "point") {
        const { x, z } = h.point;
        this.addRibbon([{ x: x - 0.25, z }, { x: x + 0.25, z }], 0.06, led, 0.026);
        this.addRibbon([{ x, z: z - 0.25 }, { x, z: z + 0.25 }], 0.06, led, 0.026);
      } else {
        const { min, max } = h;
        this.addRibbon([min, { x: max.x, z: min.z }, max, { x: min.x, z: max.z }], 0.06, led, 0.026, true);
      }
    }
    for (const path of input.ballPaths ?? []) {
      if (path.length < 2) continue;
      const geo = new THREE.BufferGeometry().setFromPoints(path.map((q) => new THREE.Vector3(q.x, q.y, q.z)));
      this.overlay.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: input.colors.ball, transparent: true, opacity: 0.7 })));
    }
  }

  /**
   * Numbers on the jersey when the label is a number: about 14 cm on the chest and 20 cm on the back, following the
   * chest, in white or navy, whichever stands out against the jersey.
   */
  private placeNumbers(a: Avatar, p: PosedPlayer, team: string) {
    const label = p.token.label.replace(/^#/, "");
    if (!/^\d{1,2}$/.test(label)) {
      if (a.numbers) {
        for (const m of [a.numbers.front, a.numbers.back]) { this.board.dynamic.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
        a.numbers = undefined;
      }
      return;
    }
    const c = new THREE.Color(team);
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const ink = lum > 0.45 ? "#11183A" : "#FFFFFF";
    const key = `${label}|${ink}`;
    if (a.numbers?.key !== key) {
      if (a.numbers) for (const m of [a.numbers.front, a.numbers.back]) { this.board.dynamic.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      const tex = numberTexture(label, ink);
      const make = () => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({
          map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
        m.renderOrder = 1;
        this.board.dynamic.add(m);
        return m;
      };
      a.numbers = { key, front: make(), back: make() };
    }
    const h = a.stature;
    const chest = p.joints[Joint.chest];
    const r = chest.rotation;
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const img = numberTexture(label, ink).image as HTMLCanvasElement;
    const aspect = img.width / img.height;
    for (const front of [true, false]) {
      const m = front ? a.numbers!.front : a.numbers!.back;
      const height = (front ? 0.075 : 0.11) * h;
      m.scale.set(height * aspect, height, 1);
      const spot = a.athlete?.numberSpot(front);
      if (spot) {
        // On the athlete's shirt.
        m.position.copy(spot.position);
        m.quaternion.copy(spot.quaternion);
        continue;
      }
      const at = chest.apply(front ? new V3(0, -0.012 * h, 0.076 * h) : new V3(0, -0.03 * h, -0.075 * h));
      m.position.set(at.x, at.y, at.z);
      m.quaternion.copy(q);
      if (!front) m.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    }
  }

  /** Hides the eye-view player while the camera is within half a metre of their eyes. */
  setHidden(id: string | undefined) {
    if (this.hidden === id) return;
    this.hidden = id;
    this.applyHidden();
  }

  /** The eye of a posed player (for the eye-view hiding test). */
  eyeOf(id: string): THREE.Vector3 | undefined {
    const p = this.posed.find((q) => q.id === id);
    if (!p) return undefined;
    const e = p.skeleton.eye(p.joints);
    return new THREE.Vector3(e.x, e.y, e.z);
  }

  /**
   * The player under a screen position: the nearest body (a vertical cylinder round the pelvis, 0.34 m wide, from
   * the floor to above the head) hit by the touch ray.
   */
  pick(clientX: number, clientY: number): string | undefined {
    const r = this.board.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.board.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    let best: { id: string; t: number } | undefined;
    for (const p of this.posed) {
      if (p.id === this.hidden) continue;
      const c = p.joints[Joint.pelvis].translation;
      const top = p.headCentre.y + 0.15;
      const ox = o.x - c.x, oz = o.z - c.z;
      const A = d.x * d.x + d.z * d.z, B = 2 * (ox * d.x + oz * d.z), C = ox * ox + oz * oz - 0.34 * 0.34;
      let t: number | undefined;
      if (A < 1e-9) {
        if (C <= 0) t = (top - o.y) / d.y;
      } else {
        const disc = B * B - 4 * A * C;
        if (disc >= 0) {
          const s = Math.sqrt(disc);
          for (const tt of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) {
            const y = o.y + tt * d.y;
            if (tt > 0 && y >= 0 && y <= top) { t = tt; break; }
          }
          // Looking straight down through the top of the cylinder.
          if (t === undefined && Math.abs(d.y) > 1e-6) {
            const tt = (top - o.y) / d.y, x = ox + tt * d.x, z = oz + tt * d.z;
            if (tt > 0 && x * x + z * z <= 0.34 * 0.34) t = tt;
          }
        }
      }
      if (t !== undefined && (!best || t < best.t)) best = { id: p.id, t };
    }
    return best?.id;
  }

  private addAvatar(id: string, stature: number): Avatar {
    const rest = restBuffers(stature);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(rest.positions.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("normal", new THREE.BufferAttribute(rest.normals.slice(), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(rest.positions.length), 3));
    geometry.setIndex(new THREE.BufferAttribute(rest.indices, 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
    label.renderOrder = 10;
    label.center.set(0.5, 0);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.44, 40),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    this.board.dynamic.add(mesh, label, ring);
    const a: Avatar = { stature, mesh, geometry, colorKey: "", label, labelText: "", ring };
    this.avatars.set(id, a);
    return a;
  }

  private removeAvatar(a: Avatar) {
    a.athlete?.dispose();
    this.board.dynamic.remove(a.mesh, a.label, a.ring);
    if (a.numbers) for (const m of [a.numbers.front, a.numbers.back]) { this.board.dynamic.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    a.geometry.dispose();
    (a.mesh.material as THREE.Material).dispose();
    (a.label.material as THREE.Material).dispose();
    a.ring.geometry.dispose();
    (a.ring.material as THREE.Material).dispose();
  }

  /** Vertex colours per material: the jersey takes the team colour; socks are the shoes' colour, a touch darker. */
  private paint(a: Avatar, team: string, c: BoardColors, key: string) {
    const rest = restBuffers(a.stature);
    const col = (s: string) => new THREE.Color(s);
    const M = AvatarMaterial;
    const palette = new Map<number, THREE.Color>([
      [M.skin, col(c.skin)], [M.jersey, col(team)], [M.shorts, col(c.shorts)], [M.pads, col(c.pads)],
      [M.shoes, col(c.shoes)], [M.hair, col(c.hair)], [M.socks, col(c.shoes).lerp(col(c.shorts), 0.12)],
    ]);
    const attr = a.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < rest.materials.length; i++) {
      const k = palette.get(rest.materials[i]) ?? palette.get(M.skin)!;
      arr[3 * i] = k.r;
      arr[3 * i + 1] = k.g;
      arr[3 * i + 2] = k.b;
    }
    attr.needsUpdate = true;
    a.colorKey = key;
  }

  private applyHidden() {
    for (const [id, a] of this.avatars) {
      const shown = id !== this.hidden;
      a.mesh.visible = shown && !a.athlete;
      if (a.athlete) a.athlete.visible = shown;
      a.label.visible = shown;
      if (a.numbers) a.numbers.front.visible = a.numbers.back.visible = shown;
    }
  }

  private clearOverlay() {
    for (const o of [...this.overlay.children]) {
      this.overlay.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
  }

  private addRibbon(points: readonly FloorPoint[], width: number, color: string, lift: number, closed = false, opacity = 1) {
    const g = ribbon(points, width, lift, closed);
    if (!g) return;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: false }));
    m.renderOrder = 2;
    this.overlay.add(m);
  }

  /** A zone on the floor: its pattern (lines, cross-hatch, dots, glow) clipped to its outline, and the outline. */
  private addZone(z: Zone, color: string, selected: boolean, led: string, lift: number) {
    const outline = Zone.outline(z);
    if (outline.length < 3) return;
    const s = z.style;
    const opacity = Math.max(0, Math.min(1, s.opacity / 0.55));
    // ShapeGeometry lies in its XY plane; turned onto the floor, shape y becomes world -z.
    const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.z)));
    const tex = patternTexture(s.pattern);
    if (tex || s.pattern === "glowFill") {
      const geo = new THREE.ShapeGeometry(shape);
      let map: THREE.Texture | null = null;
      if (tex) {
        map = tex.clone();
        const sp = Math.max(0.12, s.spacing);
        map.repeat.set(1 / sp, 1 / sp);
        map.rotation = s.angle;
        map.needsUpdate = true;
      }
      const mat = new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity: tex ? opacity : 0.32 * opacity,
        depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = lift;
      mesh.renderOrder = 1;
      this.overlay.add(mesh);
    }
    this.addRibbon(outline, selected ? 0.09 : 0.05, color, lift + 0.001, true, Math.max(0.4, opacity));
    if (selected) this.addRibbon(outline, 0.03, led, lift + 0.002, true);
    // Walls and cylinders (no-fly, serve target, tip alert): a translucent band rising from the outline, fading upward.
    const ext = s.extrusion;
    const height = "wall" in ext ? ext.wall.height : "cylinder" in ext ? ext.cylinder.height : 0;
    if (height > 0) {
      const ring = [...outline, outline[0]];
      const c = new THREE.Color(color);
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      ring.forEach((p, i) => {
        pos.push(p.x, 0, p.z, p.x, height, p.z);
        col.push(c.r, c.g, c.b, 0.42 * opacity, c.r, c.g, c.b, 0);
        if (i > 0) { const k = 2 * (i - 1); idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
      geo.setIndex(idx);
      const wall = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false,
        side: THREE.DoubleSide }));
      wall.renderOrder = 3;
      this.overlay.add(wall);
    }
  }
}
