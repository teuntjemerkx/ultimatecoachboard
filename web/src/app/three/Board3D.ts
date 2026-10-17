import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * The 3D board (Section 3.2) on the web: the hall floor with the court and its lines, the net with tape, posts and
 * antennas, an orbit camera that turns around the court, and a first-person camera for eye views. World metres,
 * Y up, the net plane at Z = 0, home half at +Z (the core's frame).
 */
export interface BoardColors {
  hallFloor: string;
  freeZone: string;
  court: string;
  courtLine: string;
  net: string;
  home: string;
  opponent: string;
  ball: string;
  skin: string;
  shorts: string;
  pads: string;
  shoes: string;
  hair: string;
  bg: string;
}

export interface Orbit {
  target: THREE.Vector3;
  /** Horizontal direction from the target toward the eye, radians from +X toward +Z (0: the home bench at +X). */
  heading: number;
  /** Eye elevation above the floor plane, radians. */
  pitch: number;
  distance: number;
  fovY: number;
}

export function benchOrbit(aspect: number): Orbit {
  const fov = 45;
  const width = 22;
  const distance = Math.max(14, (width / (2 * Math.tan((fov * Math.PI) / 360) * Math.max(aspect, 0.6))) * 1.05);
  return { target: new THREE.Vector3(0, 0, 0), heading: 0.2, pitch: (32 * Math.PI) / 180, distance, fovY: fov };
}

export function orbitEye(o: Orbit): THREE.Vector3 {
  const h = new THREE.Vector3(Math.cos(o.heading), 0, Math.sin(o.heading));
  return o.target.clone().add(h.multiplyScalar(Math.cos(o.pitch) * o.distance)).add(new THREE.Vector3(0, Math.sin(o.pitch) * o.distance, 0));
}

/**
 * The board draws a frame only when something changed (`invalidate`: the players moved, the camera turned or flies,
 * the canvas resized), so a board nobody touches costs nothing; the players' shadows are drawn again only when they move.
 */
export class Board3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.04, 400);
  orbit: Orbit;
  private floorTexture?: THREE.CanvasTexture;
  private floorMesh?: THREE.Mesh;
  private netGroup = new THREE.Group();
  readonly dynamic = new THREE.Group();
  private frame = 0;
  private flight?: { from: THREE.PerspectiveCamera; to: () => { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number }; start: number; duration: number };
  /** While set, the camera follows this pose (eye view); it is read again on every frame drawn. */
  firstPerson?: () => { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number };
  /**
   * Called on every frame the board is awake, before it draws. Return true to keep it awake (a screen that polls for
   * changes, then calls `invalidate`); otherwise it sleeps once nothing changes.
   */
  onFrame?: (t: number) => boolean | void;
  private disposed = false;
  /** Something changed since the last frame drawn. */
  private dirty = true;
  /** The players moved: their shadows are drawn again with the next frame. */
  private shadowsDirty = true;
  // Scratch objects for the camera, so a frame allocates nothing.
  private readonly eye = new THREE.Vector3();
  private readonly look = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 45 };
  private readonly shown = { pos: new THREE.Vector3(NaN, NaN, NaN), quat: new THREE.Quaternion(), fov: NaN, near: NaN };

  constructor(readonly canvas: HTMLCanvasElement, private colors: BoardColors, netHeight: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    // At most 1.5 device pixels per point: on a Retina iPad, about half the pixels of the full 2x for nearly the same picture.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.orbit = benchOrbit(1.4);
    this.scene.background = new THREE.Color(colors.hallFloor);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.4));
    // A hall's soft reflections on skin and fabric (the players are physically based), and one light high over the
    // court that casts soft shadows of the players on the floor.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Drawn again only when the players move (invalidate with shadows).
    this.renderer.shadowMap.autoUpdate = false;
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 18, 9);
    sun.castShadow = true;
    // 2048: at 1024 the soft edges spread twice as far and the shadows of legs and arms fade (drawn only when players move).
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 16, bottom: -16, near: 1, far: 45 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.buildFloor();
    this.buildNet(netHeight);
    this.scene.add(this.netGroup, this.dynamic);
    this.resize();
    // The dev tools find the board through its canvas (see renderNow).
    if (import.meta.env.DEV) (canvas as HTMLCanvasElement & { board?: Board3D }).board = this;
  }

  /** Draws a new frame soon: something on the board changed (`shadows`: the players moved). */
  invalidate(shadows = false) {
    this.dirty = true;
    if (shadows) this.shadowsDirty = true;
    this.wake();
  }

  private wake() {
    if (this.frame === 0 && !this.disposed) this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (t: number) => {
    this.frame = 0;
    if (this.disposed) return;
    const poll = this.onFrame?.(t) === true;
    const moved = this.stepCamera(t);
    const draw = this.dirty || moved;
    if (draw) {
      this.dirty = false;
      if (this.shadowsDirty) {
        this.shadowsDirty = false;
        this.renderer.shadowMap.needsUpdate = true;
      }
      this.renderer.render(this.scene, this.camera);
    }
    // A frame drawn keeps the board awake one more frame (playback invalidates every frame); then it sleeps.
    if (draw || poll || this.flight) this.wake();
  };

  /**
   * Draws one frame now, whatever the browser's frame clock does (it stops in a page that is not on screen): the
   * dev tools record a film frame by frame with it (tools/filmframes.js).
   */
  renderNow(t = performance.now()) {
    if (this.disposed) return;
    this.onFrame?.(t);
    this.stepCamera(t);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.scene.environment?.dispose();
    this.floorTexture?.dispose();
    this.renderer.dispose();
    // Hands the GPU memory back at once (Safari keeps only a few WebGL contexts).
    this.renderer.forceContextLoss();
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  setColors(c: BoardColors, netHeight: number) {
    this.colors = c;
    this.scene.background = new THREE.Color(c.hallFloor);
    this.buildFloor();
    this.buildNet(netHeight);
    this.invalidate(true);
  }

  // MARK: - Floor and net

  /** The floor as one texture: hall, free zone (3 m round the court), the court and its 5 cm lines. */
  private buildFloor() {
    const W = 20, L = 34, ppm = 64;
    const cv = document.createElement("canvas");
    cv.width = W * ppm;
    cv.height = L * ppm;
    const g = cv.getContext("2d")!;
    const X = (x: number) => (x + W / 2) * ppm, Z = (z: number) => (z + L / 2) * ppm;
    g.fillStyle = this.colors.hallFloor;
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = this.colors.freeZone;
    g.fillRect(X(-7.5), Z(-12), 15 * ppm, 24 * ppm);
    g.fillStyle = this.colors.court;
    g.fillRect(X(-4.5), Z(-9), 9 * ppm, 18 * ppm);
    g.strokeStyle = this.colors.courtLine;
    g.lineWidth = 0.05 * ppm;
    g.strokeRect(X(-4.5) + g.lineWidth / 2, Z(-9) + g.lineWidth / 2, 9 * ppm - g.lineWidth, 18 * ppm - g.lineWidth);
    for (const z of [-3, 0, 3]) {
      g.beginPath();
      g.moveTo(X(-4.5), Z(z));
      g.lineTo(X(4.5), Z(z));
      g.stroke();
    }
    // Attack lines continue as dashes 1.75 m beyond the sidelines.
    g.setLineDash([0.15 * ppm, 0.2 * ppm]);
    for (const z of [-3, 3]) for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(X(s * 4.5), Z(z));
      g.lineTo(X(s * 6.25), Z(z));
      g.stroke();
    }
    g.setLineDash([]);
    this.floorTexture?.dispose();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.floorTexture = tex;
    if (this.floorMesh) this.scene.remove(this.floorMesh);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshLambertMaterial({ map: tex }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.name = "floor";
    mesh.receiveShadow = true;
    this.floorMesh = mesh;
    this.scene.add(mesh);
  }

  /** Net 9.5 m by 1 m with 10 cm mesh, white tape on top, posts 0.5 m outside the sidelines, striped antennas. */
  private buildNet(netHeight: number) {
    this.netGroup.clear();
    const cv = document.createElement("canvas");
    cv.width = 950;
    cv.height = 100;
    const g = cv.getContext("2d")!;
    g.strokeStyle = this.colors.net;
    g.lineWidth = 1.5;
    for (let x = 0; x <= 950; x += 10) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 100); g.stroke(); }
    for (let y = 0; y <= 100; y += 10) { g.beginPath(); g.moveTo(0, y); g.lineTo(950, y); g.stroke(); }
    g.fillStyle = "#FFFFFF";
    g.fillRect(0, 0, 950, 7);
    g.fillRect(0, 94, 950, 6);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const net = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    net.position.set(0, netHeight - 0.5, 0);
    net.name = "net";
    this.netGroup.add(net);
    const postMat = new THREE.MeshLambertMaterial({ color: this.colors.net });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, netHeight + 0.15, 12), postMat);
      post.position.set(s * 5.5, (netHeight + 0.15) / 2, 0);
      this.netGroup.add(post);
      const ant = new THREE.Group();
      for (let k = 0; k < 9; k++) {
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.2, 6),
          new THREE.MeshBasicMaterial({ color: k % 2 ? "#FFFFFF" : "#E5322D" }));
        seg.position.set(s * 4.5, netHeight - 1 + 0.1 + k * 0.2, 0);
        ant.add(seg);
      }
      this.netGroup.add(ant);
    }
  }

  // MARK: - Cameras

  setOrbit(o: Orbit, animate = true) {
    if (animate) {
      const from = this.camera.clone();
      this.flight = { from, to: () => this.orbitPose(o), start: performance.now(), duration: 700 };
    }
    this.orbit = o;
    this.invalidate();
  }

  /** The camera pose of an orbit (in a scratch object: read it before the next call). */
  private orbitPose(o: Orbit) {
    const h = o.heading, d = o.distance, c = Math.cos(o.pitch) * d;
    this.eye.set(o.target.x + Math.cos(h) * c, o.target.y + Math.sin(o.pitch) * d, o.target.z + Math.sin(h) * c);
    this.look.lookAt(this.eye, o.target, this.up);
    this.pose.pos.copy(this.eye);
    this.pose.quat.setFromRotationMatrix(this.look);
    this.pose.fov = o.fovY;
    return this.pose;
  }

  /** Into a player's eyes along a raised arc (Section 5.1), then head-locked. */
  flyTo(pose: () => { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number }) {
    this.flight = { from: this.camera.clone(), to: pose, start: performance.now(), duration: 1100 };
    this.firstPerson = pose;
    this.invalidate();
  }

  leaveFirstPerson() {
    this.firstPerson = undefined;
    this.flight = { from: this.camera.clone(), to: () => this.orbitPose(this.orbit), start: performance.now(), duration: 900 };
    this.invalidate();
  }

  /** Places the camera for this frame; true when it moved since the frame last drawn. */
  private stepCamera(now: number): boolean {
    const cam = this.camera;
    if (this.flight) {
      const f = Math.min(1, (now - this.flight.start) / this.flight.duration);
      const e = criticallyDamped(f);
      const to = this.flight.to();
      const from = this.flight.from;
      // A raised arc: the midpoint lifts by a fifth of the distance.
      const lift = from.position.distanceTo(to.pos) * 0.2 * Math.sin(Math.PI * e);
      cam.position.lerpVectors(from.position, to.pos, e);
      cam.position.y += lift;
      cam.quaternion.slerpQuaternions(from.quaternion, to.quat, e);
      cam.fov = from.fov + (to.fov - from.fov) * e;
      if (f >= 1) this.flight = undefined;
    } else {
      const target = this.firstPerson ? this.firstPerson() : this.orbitPose(this.orbit);
      cam.position.copy(target.pos);
      cam.quaternion.copy(target.quat);
      cam.fov = target.fov;
    }
    cam.near = this.firstPerson ? 0.04 : 0.25;
    const s = this.shown;
    if (s.pos.equals(cam.position) && s.quat.equals(cam.quaternion) && s.fov === cam.fov && s.near === cam.near) return false;
    s.pos.copy(cam.position);
    s.quat.copy(cam.quaternion);
    s.fov = cam.fov;
    s.near = cam.near;
    cam.updateProjectionMatrix();
    return true;
  }

  /** Orbit by a screen drag (points) and zoom by a pinch scale. */
  orbitBy(dx: number, dy: number, zoom = 1) {
    const o = this.orbit;
    o.heading -= dx * 0.006;
    o.pitch = Math.max(0.08, Math.min(Math.PI / 2 - 0.02, o.pitch + dy * 0.005));
    o.distance = Math.max(4, Math.min(80, o.distance / Math.max(zoom, 0.05)));
    this.invalidate();
  }

  // MARK: - Picking

  /** The floor point under a screen position, or null above the horizon. */
  floorPoint(clientX: number, clientY: number): { x: number; z: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (!(t > 0) || !Number.isFinite(t)) return null;
    const p = ray.ray.origin.clone().add(ray.ray.direction.clone().multiplyScalar(t));
    return { x: p.x, z: p.z };
  }

  /** Screen position (CSS pixels within the canvas) of a world point, or null behind the camera. */
  screenPoint(p: THREE.Vector3): { x: number; y: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }
}

/** Critically damped easing (Section 1.6), normalised to reach 1 at t = 1. */
export function criticallyDamped(t: number): number {
  const w = 7;
  const f = (x: number) => 1 - (1 + w * x) * Math.exp(-w * x);
  return f(Math.max(0, Math.min(1, t))) / f(1);
}
