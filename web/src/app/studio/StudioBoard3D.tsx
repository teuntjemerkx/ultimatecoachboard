import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";
import type { FloorPoint } from "../../core/match/court";
import { Gaze, PlayerBodies, V3, type GazeAim, type GazeReadout, type PosedPlayer } from "../../core/spatial";
import { Zone, sceneTimeline, type BallPlan, type SceneFrame } from "../../core/zones";
import { benchOrbit, type Board3D, type BoardColors, type Orbit } from "../three/Board3D";
import { Court3DView, boardColors } from "../three/Court3DView";
import { Players3D } from "../three/Players3D";
import { ballPlanOf, studioBodies, useStudio, type StudioState } from "./studio";

/** Upright views stand the court upright, as the 2D board does. */
export const uprightAspect = (aspect: number) => aspect < 1 / 1.1;

/**
 * The Studio's orbit: at the home bench in landscape (home on the left, as in 2D), behind the home end line when the
 * board stands upright; `topDown` looks straight down with the same orientation (the 2D board's view).
 */
export function studioOrbit(aspect: number, flipped: boolean, topDown = false): Orbit {
  const vertical = uprightAspect(aspect);
  const o = benchOrbit(aspect);
  const t = 2 * Math.tan((o.fovY * Math.PI) / 360);
  const a = Math.max(aspect, 0.4);
  o.heading = vertical ? (flipped ? -Math.PI / 2 : Math.PI / 2) : flipped ? Math.PI + 0.2 : 0.2;
  if (topDown) {
    // The free zone (15 by 24 m) fills the view.
    const [across, along] = vertical ? [15, 24] : [24, 15];
    o.pitch = Math.PI / 2 - 0.02;
    o.heading = vertical ? (flipped ? -Math.PI / 2 : Math.PI / 2) : flipped ? Math.PI : 0;
    o.distance = Math.max(across / (t * a), along / t) * 1.05;
  } else if (vertical) {
    o.pitch = (36 * Math.PI) / 180;
    o.distance = Math.max(14, (16 / (t * a)) * 1.05);
  }
  return o;
}

/** Sight lines of a player (Section 5.6): to the targets (by default the read cues), the ball first. */
export function sightLines(players: readonly PosedPlayer[], viewerId: string, pov: { id?: string; yaw: number; pitch: number },
  ball?: { x: number; y: number; z: number }, aspect = 1.4, targets?: readonly (readonly [string, GazeAim])[],
): { eye: V3; readouts: GazeReadout[] } | undefined {
  const viewer = players.find((p) => p.id === viewerId);
  if (!viewer) return undefined;
  const look = pov.id === viewerId ? { yaw: pov.yaw, pitch: pov.pitch } : {};
  const pose = viewer.skeleton.povPose(viewer.joints, aspect, look);
  const readouts = Gaze.readouts(viewer, pose, targets ?? Gaze.defaultTargets(viewer, players), players, PlayerBodies.netHeight,
    ball ? new V3(ball.x, ball.y, ball.z) : undefined);
  return { eye: pose.eye, readouts };
}

type Gesture =
  | { kind: "look"; last: { x: number; y: number } }
  | { kind: "stroke" }
  | { kind: "token" | "zone"; id: string; start: FloorPoint; base: FloorPoint };

interface Drag { kind: "token" | "zone"; id: string; at: FloorPoint; dx: number; dz: number; moved: boolean }

/** The frame with a player or zone shown where the finger has it. */
function withDrag(frame: SceneFrame, drag: Drag | null): SceneFrame {
  if (!drag?.moved) return frame;
  const f = Object.assign(Object.create(Object.getPrototypeOf(frame) as object), frame) as SceneFrame;
  if (drag.kind === "token") f.tokens = frame.tokens.map((t) => (t.id === drag.id ? { ...t, point: drag.at } : t));
  else f.zones = frame.zones.map((z) => (z.id === drag.id ? Zone.translated(z, drag.dx, drag.dz) : z));
  return f;
}

/** What the 3D board shows from the Studio's state: a change to any of these redraws it. */
const shownFields = ["editor", "version", "time", "bodiesVersion", "selectedToken", "selectedZone", "gaze", "gazeTargets", "pov",
  "povYaw", "povPitch", "tool", "zoneStyle", "highlights"] as const satisfies readonly (keyof StudioState)[];

let pathsOf: { plan: BallPlan; paths: V3[][] } | undefined;

/** The ball's solved flights as points in the air, the same arrays while the plan stays (the board keeps their lines). */
function ballPaths(plan: BallPlan): V3[][] {
  if (pathsOf?.plan !== plan) pathsOf = { plan, paths: plan.segments.flatMap((seg) => (seg.trajectory ? [seg.trajectory.samples.map((q) => q.p)] : [])) };
  return pathsOf.paths;
}

/**
 * The 3D board wired to the Studio (Section 3.2). One finger on a player or zone drags it (it snaps as in 2D), with
 * Draw or Zone it draws on the floor through the touch ray, anywhere else it turns the court; two fingers turn and
 * pinch. A tap selects. In eye view the camera rides in the player's head and one finger looks around. The board is
 * redrawn straight from the store (playback changes the time every frame), not through React.
 */
export function StudioBoard3D({ themeKey, netHeight, onBoard, inset = 0, size }: {
  themeKey: string;
  netHeight: number;
  onBoard?: (board: Board3D | null) => void;
  /** Pixels at the bottom covered by the Studio's strips: the picture shifts up so the court sits above them. */
  inset?: number;
  size?: { w: number; h: number };
}) {
  const st = useStudio(useShallow((s) => ({ pov: s.pov, flipped: s.flipped })));
  const boardRef = useRef<Board3D | null>(null);
  const playersRef = useRef<Players3D | null>(null);
  const posedRef = useRef<PosedPlayer[]>([]);
  const gesture = useRef<Gesture | null>(null);
  const strokeRef = useRef<FloorPoint[] | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** Counts boards made (React's development mode makes the canvas twice); 0 until the first. */
  const [ready, setReady] = useState(0);
  const flippedRef = useRef(st.flipped);
  /** The theme's colours, read from the CSS once per theme. */
  const colors = useRef<{ key: string; colors: BoardColors } | null>(null);

  /** Redraws the players, the ball, zones, ink and sight lines for the moment shown. */
  const redraw = () => {
    const players = playersRef.current;
    const s = useStudio.getState();
    if (!players || !s.editor) return;
    const drag = dragRef.current, stroke = strokeRef.current;
    const frame = withDrag(s.frame(), drag);
    const posed = studioBodies(s.scene(), s.time, frame, drag?.kind === "token" && drag.moved ? drag.id : undefined);
    posedRef.current = posed;
    const ball = s.ball();
    const gaze = s.gaze ? sightLines(posed, s.gaze, { id: s.pov, yaw: s.povYaw, pitch: s.povPitch }, ball,
      boardRef.current?.camera.aspect, s.gazeTargetList(posed)) : undefined;
    const scene = s.scene();
    if (colors.current?.key !== `${themeKey}|${netHeight}`) colors.current = { key: `${themeKey}|${netHeight}`, colors: boardColors() };
    players.update({
      players: posed, colors: colors.current.colors, selected: s.selectedToken, ball, zones: frame.zones, selectedZone: s.selectedZone,
      ink: scene.ink,
      stroke: stroke ? { points: stroke, zone: s.tool === "zone", tint: s.zoneStyle.tint } : undefined,
      gaze: gaze?.readouts.map((r) => ({ from: gaze.eye, to: r.point, visible: r.visibility.fraction >= 0.5 })),
      highlights: s.highlights, ballPaths: sceneTimeline(scene).length ? ballPaths(ballPlanOf(scene)) : undefined,
    });
  };
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  const setDragBoth = (d: Drag | null) => { dragRef.current = d; redrawRef.current(); };
  const setStroke = (points: FloorPoint[] | null) => { strokeRef.current = points; redrawRef.current(); };

  const onDispose = (b: Board3D) => {
    if (boardRef.current !== b) return;
    playersRef.current?.dispose();
    playersRef.current = null;
    boardRef.current = null;
    onBoard?.(null);
  };

  const onReady = (b: Board3D) => {
    boardRef.current = b;
    playersRef.current = new Players3D(b);
    const aspect = b.camera.aspect;
    const s = useStudio.getState();
    if (s.pov) {
      b.setOrbit(studioOrbit(aspect, s.flipped), false);
    } else {
      // Fly down from the 2D board's view to the bench (the first frame renders from straight above).
      b.setOrbit(studioOrbit(aspect, s.flipped, true), false);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (boardRef.current === b && !b.firstPerson) b.setOrbit(studioOrbit(b.camera.aspect, useStudio.getState().flipped), true);
      }));
    }
    // The eye-view player disappears once the camera is in their head.
    b.onFrame = () => {
      const pov = useStudio.getState().pov;
      const players = playersRef.current;
      if (!players) return;
      if (!pov || !b.firstPerson) { players.setHidden(undefined); return; }
      const eye = players.eyeOf(pov);
      players.setHidden(eye && b.camera.position.distanceTo(eye) < 0.6 ? pov : undefined);
    };
    onBoard?.(b);
    setReady((n) => n + 1);
  };

  // Redraw when what the board shows changes in the store (the time at every frame of playback), or the theme.
  useEffect(() => {
    if (!ready) return;
    redrawRef.current();
    return useStudio.subscribe((s, prev) => {
      if (shownFields.some((k) => s[k] !== prev[k])) redrawRef.current();
    });
  }, [ready]);
  useEffect(() => { if (ready) redrawRef.current(); }, [ready, themeKey, netHeight]);

  // The strips over the bottom of the board: shift the picture up by half their height (a view offset, so picking
  // and the eye view stay exact).
  useEffect(() => {
    const b = boardRef.current;
    if (!ready || !b) return;
    const w = b.canvas.clientWidth, h = b.canvas.clientHeight;
    if (inset > 0 && w > 0 && h > inset) b.camera.setViewOffset(w, h, 0, inset / 2, w, h);
    else b.camera.clearViewOffset();
    b.invalidate();
  }, [ready, inset, size?.w, size?.h]);

  // Into the player's eyes and back out (Section 5.1).
  useEffect(() => {
    const b = boardRef.current;
    if (!ready || !b) return;
    if (st.pov) {
      b.flyTo(() => {
        const s = useStudio.getState();
        const p = posedRef.current.find((q) => q.id === s.pov);
        if (!p) return { pos: b.camera.position.clone(), quat: b.camera.quaternion.clone(), fov: b.camera.fov };
        const pose = p.skeleton.povPose(p.joints, b.camera.aspect, { yaw: s.povYaw, pitch: s.povPitch });
        const r = pose.rotation;
        return { pos: new THREE.Vector3(pose.eye.x, pose.eye.y, pose.eye.z), quat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
                 fov: (pose.fovY * 180) / Math.PI };
      });
    } else if (b.firstPerson) b.leaveFirstPerson();
  }, [ready, st.pov]);

  // Swap ends turns the camera to the other bench.
  useEffect(() => {
    const b = boardRef.current;
    if (!ready || !b || flippedRef.current === st.flipped) return;
    flippedRef.current = st.flipped;
    if (!st.pov) b.setOrbit(studioOrbit(b.camera.aspect, st.flipped), true);
  }, [ready, st.flipped, st.pov]);

  const handlers = {
    onDown(x: number, y: number): boolean {
      const s = useStudio.getState(), b = boardRef.current, players = playersRef.current;
      if (!b || !players || !s.editor) return false;
      if (s.playing) s.togglePlay();
      if (s.pov) { gesture.current = { kind: "look", last: { x, y } }; return true; }
      const w = b.floorPoint(x, y);
      if (s.aimingLanding) { gesture.current = null; return false; }
      if (s.tool !== "move") {
        if (!w) return false;
        gesture.current = { kind: "stroke" };
        setStroke([w]);
        return true;
      }
      const frame = s.frame();
      const id = players.pick(x, y);
      const token = id ? frame.tokens.find((t) => t.id === id) : undefined;
      if (token) {
        gesture.current = { kind: "token", id: token.id, start: w ?? token.point, base: token.point };
        return true;
      }
      const zone = w ? frame.zoneAt(w) : undefined;
      if (w && zone) {
        gesture.current = { kind: "zone", id: zone.id, start: w, base: w };
        return true;
      }
      gesture.current = null;
      return false;
    },
    onMove(x: number, y: number) {
      const g = gesture.current, b = boardRef.current;
      if (!g || !b) return;
      if (g.kind === "look") {
        useStudio.getState().look((x - g.last.x) * 0.004, (y - g.last.y) * 0.004);
        g.last = { x, y };
        return;
      }
      const w = b.floorPoint(x, y);
      if (!w) return;
      if (g.kind === "stroke") {
        const pts = strokeRef.current;
        if (!pts) return;
        const last = pts[pts.length - 1];
        if (Math.hypot(w.x - last.x, w.z - last.z) > 0.04) setStroke([...pts, w]);
        return;
      }
      const dx = w.x - g.start.x, dz = w.z - g.start.z;
      const moved = (dragRef.current?.moved ?? false) || Math.hypot(dx, dz) > 0.12;
      setDragBoth({ kind: g.kind, id: g.id, at: { x: g.base.x + dx, z: g.base.z + dz }, dx, dz, moved });
    },
    onUp(x: number, y: number, moved: boolean) {
      const g = gesture.current, s = useStudio.getState(), b = boardRef.current, players = playersRef.current;
      gesture.current = null;
      if (!b || !players || !s.editor) return;
      if (g?.kind === "stroke") {
        const pts = strokeRef.current ?? [];
        setStroke(null);
        if (s.tool === "pen") s.addInk(pts);
        else s.addZone(pts);
        return;
      }
      if (g?.kind === "token" || g?.kind === "zone") {
        const d = dragRef.current;
        setDragBoth(null);
        if (!d?.moved) s.select(g.kind === "token" ? g.id : undefined, g.kind === "zone" ? g.id : undefined);
        else if (g.kind === "token") { s.moveToken(g.id, d.at); s.select(g.id, undefined); }
        else { s.moveZone(g.id, d.dx, d.dz); s.select(undefined, g.id); }
        return;
      }
      if (moved) return;
      // A tap: aim the ball's landing, or pick a player (in eye view another player becomes a sight-line target and
      // can be switched to), else a zone, else clear the selection.
      const w = b.floorPoint(x, y);
      if (w && s.tapFloor(w)) return;
      const id = players.pick(x, y);
      if (s.pov) {
        if (id && id !== s.pov) { s.toggleGazeTarget(id); s.select(id, undefined); }
        return;
      }
      if (id) { s.select(id, undefined); return; }
      const zone = w ? s.frame().zoneAt(w) : undefined;
      s.select(undefined, zone?.id);
    },
  };

  return <Court3DView onReady={onReady} onDispose={onDispose} netHeight={netHeight} handlers={handlers} themeKey={themeKey} />;
}
