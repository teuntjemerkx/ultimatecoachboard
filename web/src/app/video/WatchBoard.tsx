import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { PosedPlayer } from "../../core/spatial";
import type { VideoCamera, VideoScene } from "../../core/video";
import { videoBodies } from "../../core/video/videoBodies";
import type { Board3D, BoardColors, Orbit } from "../three/Board3D";
import { Court3DView, boardColors } from "../three/Court3DView";
import { Players3D, cssColor } from "../three/Players3D";
import { Hall3D } from "./Hall3D";

/**
 * The orbit camera placed where the video was filmed, so the 3D view opens on the picture the coach knows. A
 * broadcast telephoto (a narrow field of view from far away) is opened at 40 degrees from closer by along the same
 * line of sight: the players' labels keep their size and the whole court stays in view. On a screen narrower than
 * the video (an iPad upright) the camera stands back so the court's width still fits.
 */
export function videoOrbit(cam: VideoCamera, aspect = cam.width / cam.height): Orbit {
  const f = cam.forward, c = cam.center;
  let target = c.add(f.mul(20));
  if (f.y < -0.03) target = c.add(f.mul(Math.min(60, c.y / -f.y)));
  const dx = c.x - target.x, dy = c.y, dz = c.z - target.z;
  let distance = Math.max(4, Math.hypot(dx, dy, dz));
  let fovY = Math.min(1.4, Math.max(0.3, cam.fovY));
  const wide = (40 * Math.PI) / 180;
  if (fovY < wide) {
    distance = Math.max((distance * Math.tan(fovY / 2)) / Math.tan(wide / 2), Math.min(distance, 24));
    fovY = wide;
  }
  if (aspect < 1.3) {
    // Wider first (up to 60 degrees), then farther back.
    const need = 1.3 / Math.max(aspect, 0.4);
    const gain = Math.max(1, Math.min(need, Math.tan(Math.PI / 6) / Math.tan(fovY / 2)));
    fovY = 2 * Math.atan(Math.tan(fovY / 2) * gain);
    distance = Math.min(70, (distance * need) / gain);
  }
  return {
    target: new THREE.Vector3(target.x, 0, target.z), heading: Math.atan2(dz, dx), pitch: Math.asin(Math.max(-1, Math.min(1, dy / Math.hypot(dx, dy, dz)))),
    distance, fovY: (fovY * 180) / Math.PI,
  };
}

/** What the watch screen tells the board; read every frame, so it lives in a ref. */
export interface WatchView {
  /** Seconds into the rally. */
  time: number;
  /** The player whose eyes the camera is in. */
  pov?: string;
  povYaw: number;
  povPitch: number;
  selected?: string;
}

/**
 * The rebuilt rally on the 3D board: the players posed as reconstructed, the ball and its flights, and the hall from
 * the video around the court. One finger turns the court (in eye view: looks around), two fingers turn and pinch;
 * a tap picks a player.
 */
export function WatchBoard({ scene, plateURL, view, themeKey, onTap, onLook }: {
  scene: VideoScene;
  plateURL?: string;
  view: MutableRefObject<WatchView>;
  themeKey: string;
  /** A tap on the board: the player under it, if any. */
  onTap: (id: string | undefined) => void;
  /** One finger dragged in eye view (radians). */
  onLook: (dYaw: number, dPitch: number) => void;
}) {
  const boardRef = useRef<Board3D | null>(null);
  const playersRef = useRef<Players3D | null>(null);
  const posedRef = useRef<PosedPlayer[]>([]);
  const extrasRef = useRef<{ hall: Hall3D; paths: THREE.Group } | null>(null);
  const colorsRef = useRef<BoardColors | null>(null);
  const look = useRef<{ x: number; y: number } | null>(null);
  const tapRef = useRef(onTap);
  tapRef.current = onTap;
  const lookRef = useRef(onLook);
  lookRef.current = onLook;
  const povRef = useRef<string | undefined>(undefined);

  useEffect(() => { colorsRef.current = null; }, [themeKey]);

  const onDispose = (b: Board3D) => {
    if (boardRef.current !== b) return;
    playersRef.current?.dispose();
    playersRef.current = null;
    const extras = extrasRef.current;
    if (extras) {
      extras.hall.dispose();
      b.dynamic.remove(extras.paths);
      for (const o of extras.paths.children) {
        (o as THREE.Line).geometry.dispose();
        ((o as THREE.Line).material as THREE.Material).dispose();
      }
    }
    extrasRef.current = null;
    boardRef.current = null;
  };

  const onReady = (b: Board3D) => {
    boardRef.current = b;
    const players = new Players3D(b);
    playersRef.current = players;
    const hall = new Hall3D(b.scene, scene, plateURL, cssColor("hall", "#B8BEC8"));
    // The ball's flights as thin lines.
    const paths = new THREE.Group();
    const ballColor = boardColors().ball;
    for (const seg of scene.ball) {
      const n = Math.max(2, Math.round((seg.t1 - seg.t0) * 30));
      const pts = Array.from({ length: n + 1 }, (_, k) => {
        const p = seg.position(seg.t0 + ((seg.t1 - seg.t0) * k) / n);
        return new THREE.Vector3(p.x, p.y, p.z);
      });
      paths.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: ballColor, transparent: true, opacity: 0.55 })));
    }
    b.dynamic.add(paths);
    extrasRef.current = { hall, paths };
    b.setOrbit(videoOrbit(scene.camera, b.camera.aspect), false);
    let shown = { time: NaN, selected: undefined as string | undefined, theme: null as BoardColors | null };
    b.onFrame = () => {
      const v = view.current;
      colorsRef.current ??= boardColors();
      const colors = colorsRef.current;
      if (v.time !== shown.time || v.selected !== shown.selected || colors !== shown.theme) {
        shown = { time: v.time, selected: v.selected, theme: colors };
        const frame = scene.frame(v.time);
        const posed = videoBodies(scene, v.time);
        posedRef.current = posed;
        players.update({ players: posed, colors, selected: v.selected, ball: frame.ball, zones: [], ink: [] });
      }
      // Into the player's eyes and back out (Section 5.1).
      if (v.pov !== povRef.current) {
        povRef.current = v.pov;
        if (v.pov) {
          b.flyTo(() => {
            const w = view.current;
            const p = posedRef.current.find((q) => q.id === w.pov);
            if (!p) return { pos: b.camera.position.clone(), quat: b.camera.quaternion.clone(), fov: b.camera.fov };
            const pose = p.skeleton.povPose(p.joints, b.camera.aspect, { yaw: w.povYaw, pitch: w.povPitch });
            const r = pose.rotation;
            return { pos: new THREE.Vector3(pose.eye.x, pose.eye.y, pose.eye.z), quat: new THREE.Quaternion(r.x, r.y, r.z, r.w),
                     fov: (pose.fovY * 180) / Math.PI };
          });
        } else if (b.firstPerson) b.leaveFirstPerson();
      }
      // The eye-view player disappears once the camera is in their head.
      if (!v.pov || !b.firstPerson) players.setHidden(undefined);
      else {
        const eye = players.eyeOf(v.pov);
        players.setHidden(eye && b.camera.position.distanceTo(eye) < 0.6 ? v.pov : undefined);
      }
    };
  };

  const handlers = {
    onDown(x: number, y: number): boolean {
      if (!view.current.pov) return false;
      look.current = { x, y };
      return true;
    },
    onMove(x: number, y: number) {
      const l = look.current;
      if (!l) return;
      lookRef.current((x - l.x) * 0.004, (y - l.y) * 0.004);
      look.current = { x, y };
    },
    onUp(x: number, y: number, moved: boolean) {
      look.current = null;
      if (moved) return;
      tapRef.current(playersRef.current?.pick(x, y));
    },
  };

  return <Court3DView onReady={onReady} onDispose={onDispose} netHeight={scene.netHeight} handlers={handlers} themeKey={themeKey} />;
}
