import type { PointerEvent, ReactNode } from "react";

/** A player on the 2D court, in world metres (home half at +Z, home's right at +X). */
export interface CourtToken {
  id: string;
  side: "home" | "opponent";
  x: number;
  z: number;
  label: string;
  isLibero?: boolean;
  isServer?: boolean;
  selected?: boolean;
  /** Where the player looks (radians from +Z toward +X); a dot on the ring shows it. */
  facing?: number;
}

/**
 * The court from above (Section 1.4) as SVG in metres. Landscape: the net runs top to bottom, home on the left as
 * seen from the bench. Portrait: the court stands upright, home at the bottom.
 */
export function Court2D({ tokens, vertical, flipped = false, onPointer, children, ball }: {
  tokens: CourtToken[];
  vertical: boolean;
  flipped?: boolean;
  onPointer?: (kind: "down" | "move" | "up", world: { x: number; z: number }, e: PointerEvent<SVGSVGElement>) => void;
  children?: ReactNode;
  ball?: { x: number; z: number; height: number };
}) {
  const m = 2.4;
  const [w, h] = vertical ? [9 + 2 * m, 18 + 2 * m] : [18 + 2 * m, 9 + 2 * m];
  const s = flipped ? -1 : 1;
  // World (x, z) to view (u, v), and back.
  const view = (x: number, z: number) => (vertical ? { u: s * x, v: s * z } : { u: -s * z, v: s * x });
  const world = (u: number, v: number) => (vertical ? { x: s * u, z: s * v } : { x: s * v, z: -s * u });
  const line = (x1: number, z1: number, x2: number, z2: number, key: string, dash?: string) => {
    const a = view(x1, z1), b = view(x2, z2);
    return <line key={key} x1={a.u} y1={a.v} x2={b.u} y2={b.v} stroke="var(--c-courtLine)" strokeWidth={0.05} strokeDasharray={dash} />;
  };
  const corner = view(-4.5, -9), far = view(4.5, 9);
  const free = { a: view(-7.5, -12), b: view(7.5, 12) };

  const toWorld = (e: PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return world(p.x, p.y);
  };

  return (
    <svg viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`} preserveAspectRatio="xMidYMid meet"
         style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
         onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onPointer?.("down", toWorld(e), e); }}
         onPointerMove={(e) => onPointer?.("move", toWorld(e), e)}
         onPointerUp={(e) => onPointer?.("up", toWorld(e), e)}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="var(--c-hallFloor)" />
      <rect x={Math.min(free.a.u, free.b.u)} y={Math.min(free.a.v, free.b.v)} width={Math.abs(free.b.u - free.a.u)}
            height={Math.abs(free.b.v - free.a.v)} fill="var(--c-freeZone)" />
      <rect x={Math.min(corner.u, far.u)} y={Math.min(corner.v, far.v)} width={Math.abs(far.u - corner.u)}
            height={Math.abs(far.v - corner.v)} fill="var(--c-court)" stroke="var(--c-courtLine)" strokeWidth={0.05} />
      {line(-4.5, 3, 4.5, 3, "a1")}
      {line(-4.5, -3, 4.5, -3, "a2")}
      {/* The net over the centre line, with its posts. */}
      {(() => {
        const a = view(-5.5, 0), b = view(5.5, 0);
        return <line x1={a.u} y1={a.v} x2={b.u} y2={b.v} stroke="var(--c-net)" strokeWidth={0.14} strokeLinecap="round" />;
      })()}
      {children}
      {tokens.map((t) => {
        const p = view(t.x, t.z);
        const r = 0.36;
        const fill = "var(--c-tokenFill)";
        const ring = t.side === "home" ? "var(--c-home)" : "var(--c-opponent)";
        const dir = t.facing !== undefined ? view(t.x + Math.sin(t.facing), t.z + Math.cos(t.facing)) : undefined;
        return (
          <g key={t.id} transform={`translate(${p.u} ${p.v})`}>
            {t.selected && <circle r={r + 0.2} fill="var(--c-led, var(--c-focus))" opacity={0.25} />}
            {t.side === "home"
              ? <circle r={r} fill={fill} stroke={ring} strokeWidth={0.08} />
              : <rect x={-r * 0.9} y={-r * 0.9} width={r * 1.8} height={r * 1.8} transform="rotate(45)" fill={fill} stroke={ring} strokeWidth={0.08} />}
            {t.isLibero && <circle r={r - 0.12} fill="none" stroke={ring} strokeWidth={0.04} />}
            {dir && <circle cx={(dir.u - p.u) * (r + 0.14)} cy={(dir.v - p.v) * (r + 0.14)} r={0.07} fill={ring} />}
            {t.isServer && <rect x={-0.12} y={r + 0.12} width={0.24} height={0.08} fill={ring} />}
            <text textAnchor="middle" dominantBaseline="central" fontSize={t.label.length > 2 ? 0.3 : 0.42}
                  fontWeight={800} fill="var(--c-tokenLabel)" style={{ fontFamily: "var(--font-athletic)", letterSpacing: "0.02em" }}>
              {t.label}
            </text>
          </g>
        );
      })}
      {ball && (() => {
        const p = view(ball.x, ball.z);
        return <circle cx={p.u} cy={p.v} r={0.13 + Math.min(ball.height, 8) * 0.02} fill="var(--c-ball)" stroke="var(--c-text)" strokeWidth={0.03} />;
      })()}
    </svg>
  );
}
