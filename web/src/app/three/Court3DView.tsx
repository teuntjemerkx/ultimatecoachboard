import { useEffect, useRef } from "react";
import { Board3D, type BoardColors } from "./Board3D";

/** Reads the template colours from the CSS variables applyTheme wrote. */
export function boardColors(): BoardColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fallback: string) => cs.getPropertyValue(`--c-${n}`).trim() || fallback;
  return {
    hallFloor: v("hallFloor", "#EEF1F5"), freeZone: v("freeZone", "#D9E2EC"), court: v("court", "#F7F3EA"),
    courtLine: v("courtLine", "#1F2937"), net: v("net", "#111827"), home: v("home", "#0067A5"), opponent: v("opponent", "#D55E00"),
    ball: v("ball", "#F2B705"), skin: v("skin", "#C9A68A"), shorts: v("shorts", "#1F2937"), pads: v("pads", "#374151"),
    shoes: v("shoes", "#FFFFFF"), hair: v("hair", "#2B2118"), bg: v("bg", "#F4F6F9"),
  };
}

export interface GestureHandlers {
  /** One finger went down on the board; return true to take the drag (moving a player), false to orbit. */
  onDown?: (clientX: number, clientY: number) => boolean;
  onMove?: (clientX: number, clientY: number) => void;
  onUp?: (clientX: number, clientY: number, moved: boolean) => void;
}

/**
 * A canvas with the 3D board. One finger: the screen's handlers decide (move a player) or the camera orbits; two
 * fingers: turn and pinch to zoom.
 */
export function Court3DView({ onReady, netHeight, handlers, themeKey }: {
  onReady: (b: Board3D) => void;
  netHeight: number;
  handlers?: GestureHandlers;
  themeKey: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardRef = useRef<Board3D | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const board = new Board3D(canvas, boardColors(), netHeight);
    boardRef.current = board;
    onReady(board);
    const ro = new ResizeObserver(() => board.resize());
    ro.observe(canvas);

    const pointers = new Map<number, { x: number; y: number }>();
    let mode: "none" | "edit" | "orbit" | "pinch" = "none";
    let moved = false;
    let last = { x: 0, y: 0 }, lastDist = 0, lastMid = { x: 0, y: 0 };
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 1) {
        mode = handlersRef.current?.onDown?.(e.clientX, e.clientY) ? "edit" : "orbit";
        last = { x: e.clientX, y: e.clientY };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        mode = "pinch";
        lastDist = Math.hypot(a.x - b.x, a.y - b.y);
        lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) > 3) moved = true;
      if (mode === "edit") handlersRef.current?.onMove?.(e.clientX, e.clientY);
      else if (mode === "orbit" && !board.firstPerson) {
        board.orbitBy(e.clientX - last.x, e.clientY - last.y);
        last = { x: e.clientX, y: e.clientY };
      } else if (mode === "pinch" && pointers.size === 2 && !board.firstPerson) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        board.orbitBy(mid.x - lastMid.x, mid.y - lastMid.y, d / Math.max(lastDist, 1));
        lastDist = d;
        lastMid = mid;
      }
    };
    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (mode === "edit" || (mode === "orbit" && !moved)) handlersRef.current?.onUp?.(e.clientX, e.clientY, moved);
      if (pointers.size === 0) mode = "none";
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); board.orbitBy(0, 0, Math.exp(-e.deltaY * 0.001)); };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      board.dispose();
      boardRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { boardRef.current?.setColors(boardColors(), netHeight); }, [themeKey, netHeight]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />;
}
