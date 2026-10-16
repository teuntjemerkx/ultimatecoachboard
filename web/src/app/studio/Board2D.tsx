import { useRef, useState } from "react";
import type { FloorPoint } from "../../core/match/court";
import { Zone, sceneTimeline, type SceneFrame, type SnapTarget } from "../../core/zones";
import type { InkStroke } from "../../core/match/liveTypes";
import { Court2D, courtView, type CourtToken } from "../ui/Court2D";
import { ballPlanOf, useStudio } from "./studio";

/** The zone tint as a theme colour: "pink" is ours (zone A), "cyan" theirs (zone B). */
export const tintColor = (tint: string) => (tint === "pink" ? "var(--c-zoneA, var(--c-home))" : "var(--c-zoneB, var(--c-opponent))");

/** One zone as SVG in view space: its pattern (lines, cross-hatch, dots, glow, outline) clipped to its outline. */
function ZoneShape({ zone, view, selected }: { zone: Zone; view: (x: number, z: number) => { u: number; v: number }; selected: boolean }) {
  const pts = Zone.outline(zone).map((p) => view(p.x, p.z));
  if (pts.length < 3) return null;
  const d = `M${pts.map((p) => `${p.u.toFixed(3)} ${p.v.toFixed(3)}`).join("L")}Z`;
  const s = zone.style;
  const color = tintColor(s.tint);
  const id = `zp-${zone.id}`;
  const deg = (s.angle * 180) / Math.PI;
  const sp = Math.max(0.12, s.spacing);
  const lw = Math.max(0.025, s.lineWidth);
  const opacity = Math.max(0, Math.min(1, s.opacity / 0.55));
  let fill = "none";
  let defs: JSX.Element | null = null;
  if (s.pattern === "diagonal" || s.pattern === "crossHatch") {
    defs = (
      <pattern id={id} patternUnits="userSpaceOnUse" width={sp} height={sp} patternTransform={`rotate(${deg})`}>
        <line x1={0} y1={0} x2={0} y2={sp} stroke={color} strokeWidth={lw} />
        {s.pattern === "crossHatch" && <line x1={0} y1={0} x2={sp} y2={0} stroke={color} strokeWidth={lw} />}
      </pattern>
    );
    fill = `url(#${id})`;
  } else if (s.pattern === "dots") {
    defs = (
      <pattern id={id} patternUnits="userSpaceOnUse" width={sp} height={sp}>
        <circle cx={sp / 2} cy={sp / 2} r={Math.max(0.035, lw * 1.4)} fill={color} />
      </pattern>
    );
    fill = `url(#${id})`;
  }
  return (
    <g opacity={opacity}>
      {defs && <defs>{defs}</defs>}
      {s.pattern === "glowFill" && <path d={d} fill={color} opacity={0.32} />}
      {fill !== "none" && <path d={d} fill={fill} />}
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 0.09 : 0.05}
            strokeDasharray={s.edge === "dashed" ? "0.25 0.18" : undefined} strokeLinejoin="round" />
      {selected && <path d={d} fill="none" stroke="var(--c-led, var(--c-focus))" strokeWidth={0.03} strokeDasharray="0.2 0.15" />}
    </g>
  );
}

/** What a drop or a zone snapped to, flashed in the LED colour: a court line, a spot (a cross) or a zone cell. */
function Highlight({ hit, view }: { hit: SnapTarget; view: (x: number, z: number) => { u: number; v: number } }) {
  const seg = (a: FloorPoint, b: FloorPoint, key: string) => {
    const p = view(a.x, a.z), q = view(b.x, b.z);
    return <line key={key} x1={p.u} y1={p.v} x2={q.u} y2={q.v} stroke="var(--c-led, var(--c-focus))" strokeWidth={0.07} strokeLinecap="round" />;
  };
  if (hit.kind === "line") return seg(hit.from, hit.to, "l");
  if (hit.kind === "point") {
    const { x, z } = hit.point;
    return <g>{seg({ x: x - 0.25, z }, { x: x + 0.25, z }, "a")}{seg({ x, z: z - 0.25 }, { x, z: z + 0.25 }, "b")}</g>;
  }
  const { min, max } = hit;
  const c = [min, { x: max.x, z: min.z }, max, { x: min.x, z: max.z }];
  return <g>{c.map((p, i) => seg(p, c[(i + 1) % 4], `c${i}`))}</g>;
}

function inkPath(points: FloorPoint[], view: (x: number, z: number) => { u: number; v: number }) {
  return points.map((p, i) => { const q = view(p.x, p.z); return `${i ? "L" : "M"}${q.u.toFixed(3)} ${q.v.toFixed(3)}`; }).join("");
}

/**
 * The Studio's 2D board: zones under the players, ink, the ball in flight. Move: drag a player (it snaps to the
 * formation's spots) or a zone; tap to select. Draw: ink with one finger. Zone: draw a shape, it becomes a zone.
 */
export function Board2D({ frame, vertical }: { frame: SceneFrame; vertical: boolean }) {
  const st = useStudio();
  const scene = st.scene();
  const { view } = courtView(vertical, st.flipped);
  const [drag, setDrag] = useState<{ kind: "token" | "zone"; id: string; start: FloorPoint; at: FloorPoint; moved: boolean } | null>(null);
  const [stroke, setStroke] = useState<FloorPoint[] | null>(null);
  const strokeRef = useRef<FloorPoint[] | null>(null);

  const ball = st.ball();
  const tokens: CourtToken[] = frame.tokens.map((t) => {
    const p = drag?.kind === "token" && drag.id === t.id ? drag.at : t.point;
    return { id: t.id, side: t.side, x: p.x, z: p.z, label: t.label, isLibero: t.role === "L", facing: t.yaw,
             selected: st.selectedToken === t.id };
  });

  const onPointer = (kind: "down" | "move" | "up", w: { x: number; z: number }) => {
    if (st.playing && kind === "down") st.togglePlay();
    if (kind === "down" && st.aimingLanding) { st.tapFloor(w); return; }
    if (st.tool === "pen" || st.tool === "zone") {
      if (kind === "down") { strokeRef.current = [w]; setStroke([w]); }
      else if (kind === "move" && strokeRef.current) {
        const last = strokeRef.current[strokeRef.current.length - 1];
        if (Math.hypot(w.x - last.x, w.z - last.z) > 0.04) { strokeRef.current = [...strokeRef.current, w]; setStroke(strokeRef.current); }
      } else if (kind === "up" && strokeRef.current) {
        const pts = strokeRef.current;
        strokeRef.current = null;
        setStroke(null);
        if (st.tool === "pen") st.addInk(pts);
        else st.addZone(pts);
      }
      return;
    }
    if (kind === "down") {
      const near = frame.tokens
        .map((t) => ({ t, d: Math.hypot(t.point.x - w.x, t.point.z - w.z) }))
        .filter((e) => e.d <= 0.6)
        .sort((a, b) => a.d - b.d)[0];
      if (near) { setDrag({ kind: "token", id: near.t.id, start: w, at: near.t.point, moved: false }); return; }
      const zone = frame.zoneAt(w);
      if (zone) { setDrag({ kind: "zone", id: zone.id, start: w, at: w, moved: false }); return; }
      st.select(undefined, undefined);
    } else if (kind === "move" && drag) {
      const moved = drag.moved || Math.hypot(w.x - drag.start.x, w.z - drag.start.z) > 0.12;
      if (drag.kind === "token") {
        const base = frame.tokens.find((t) => t.id === drag.id)!.point;
        setDrag({ ...drag, moved, at: moved ? { x: base.x + w.x - drag.start.x, z: base.z + w.z - drag.start.z } : base });
      } else setDrag({ ...drag, moved, at: w });
    } else if (kind === "up" && drag) {
      if (!drag.moved) st.select(drag.kind === "token" ? drag.id : undefined, drag.kind === "zone" ? drag.id : undefined);
      else if (drag.kind === "token") { st.moveToken(drag.id, drag.at); st.select(drag.id, undefined); }
      else { st.moveZone(drag.id, drag.at.x - drag.start.x, drag.at.z - drag.start.z); st.select(undefined, drag.id); }
      setDrag(null);
    }
  };

  const zoneOffset = drag?.kind === "zone" && drag.moved ? { id: drag.id, dx: drag.at.x - drag.start.x, dz: drag.at.z - drag.start.z } : null;
  // The ball's solved flights over the floor (Section 5.4).
  const ballPaths = sceneTimeline(scene).length
    ? ballPlanOf(scene).segments.flatMap((seg) => (seg.trajectory ? [seg.trajectory.samples.map((q) => ({ x: q.p.x, z: q.p.z }))] : []))
    : [];

  return (
    <Court2D tokens={tokens} vertical={vertical} flipped={st.flipped} onPointer={onPointer}
             ball={ball ? { x: ball.x, z: ball.z, height: ball.y } : undefined}>
      {frame.zones.map((z) => (
        <ZoneShape key={z.id} zone={zoneOffset?.id === z.id ? Zone.translated(z, zoneOffset.dx, zoneOffset.dz) : z}
                   view={view} selected={st.selectedZone === z.id} />
      ))}
      {scene.ink.map((s: InkStroke, i) => (
        <path key={i} d={inkPath(s.points, view)} fill="none" stroke="var(--c-ink)" strokeWidth={Math.max(0.05, s.width)}
              strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {ballPaths.map((path, i) => (
        <path key={`b${i}`} d={inkPath(path, view)} fill="none" stroke="var(--c-ball)" strokeWidth={0.04} strokeDasharray="0.15 0.12"
              opacity={0.8} />
      ))}
      {st.highlights.map((h, i) => <Highlight key={`h${i}`} hit={h} view={view} />)}
      {stroke && stroke.length > 1 && (
        <path d={inkPath(stroke, view)} fill="none" stroke={st.tool === "pen" ? "var(--c-ink)" : tintColor(st.zoneStyle.tint)}
              strokeWidth={0.07} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={st.tool === "zone" ? "0.2 0.12" : undefined} />
      )}
    </Court2D>
  );
}
