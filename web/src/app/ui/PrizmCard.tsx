import { useRef, useState, type ReactNode } from "react";

/** A card's finish, after the trading cards: base (squad), chrome, prizm (holographic) and gold. */
export type PrizmTier = "base" | "chrome" | "prizm" | "gold";

/**
 * A player as a trading card in 3D, built like a real Prizm refractor: a deep prism burst on foil with fine rainbow
 * diffraction lines fanning out from the light, a refraction that slides as the card turns, a glare, print grain and
 * the card in a clear plastic case; the shirt number outlined large, the name filling the bottom of the card. It tilts toward the finger while
 * pressed (the shine and the prism colours move with it) and turns over to its back when tapped, if it has one; a
 * card that picks something (`onSelect`) picks on a tap instead.
 */
/** The name as large as fits across the card (Bebas Neue capitals are about 0.42 em wide). */
function nameSize(text: string): string {
  return `${Math.min(30, 86 / (0.43 * Math.max(3, text.length)))}cqw`;
}

export function PrizmCard({ number, name, role, line, tier = "prizm", tag, back, onSelect, label, className = "" }: {
  number: number | string;
  name?: string;
  /** Short role on the violet chip ("OH", "L"). */
  role?: string;
  /** The small line beside the role (the team, the season). */
  line?: string;
  tier?: PrizmTier;
  /** A word on a black tab at the top (e.g. "On court"); none by default. */
  tag?: string;
  /** The back of the card; a tap turns the card over. */
  back?: ReactNode;
  onSelect?: () => void;
  label?: string;
  className?: string;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Each number its own place in the prism, so a team's cards do not all look alike.
  const seed = ((typeof number === "number" ? number : Number(number) || 0) * 47) % 360;
  const hue = `${seed}deg`;

  const tilt = (e: React.PointerEvent) => {
    const el = card.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    el.style.setProperty("--ry", `${(px - 0.5) * 26}deg`);
    el.style.setProperty("--rx", `${(0.5 - py) * 22}deg`);
    // The light where the finger is; the refraction slides the other way, as on real foil.
    el.style.setProperty("--mx", `${px * 100}%`);
    el.style.setProperty("--my", `${py * 100}%`);
    el.style.setProperty("--bgx", `${63 - px * 26}%`);
    el.style.setProperty("--bgy", `${67 - py * 34}%`);
  };
  const rest = () => {
    const el = card.current;
    if (!el) return;
    el.classList.remove("tilting");
    // Back to the drifting light (the animation sets these again).
    for (const v of ["--rx", "--ry", "--mx", "--my", "--bgx", "--bgy"]) el.style.removeProperty(v);
  };
  const activate = () => {
    if (onSelect) onSelect();
    else if (back) setFlipped((f) => !f);
  };

  return (
    <div className={`pcard-scene ${className}`}>
      <div ref={card} className={`pcard tier-${tier}${flipped ? " flipped" : ""}`} style={{ ["--hue" as string]: hue, ["--delay" as string]: `${(-seed / 360) * 11}s` }}
           role="button" tabIndex={0} aria-pressed={back ? flipped : undefined}
           aria-label={label ?? `${name ? `${name}, ` : ""}number ${number}${role ? `, ${role}` : ""}${back ? (flipped ? ", showing the back" : ", tap to turn over") : ""}`}
           onPointerDown={(e) => { press.current = { x: e.clientX, y: e.clientY, moved: false }; card.current?.classList.add("tilting"); tilt(e); }}
           onPointerMove={(e) => {
             if (!press.current) return;
             if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) press.current.moved = true;
             tilt(e);
           }}
           onPointerUp={() => { const p = press.current; press.current = null; rest(); if (p && !p.moved) activate(); }}
           onPointerCancel={() => { press.current = null; rest(); }}
           onPointerLeave={() => { if (press.current) { press.current = null; rest(); } }}
           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } }}>
        <div className="pcard-face pcard-front">
          <div className="pcard-art">
            <div className="pcard-rays" aria-hidden="true" />
            <div className="pcard-shine" aria-hidden="true" />
            <div className="pcard-glare" aria-hidden="true" />
            {tag && <span className="pcard-tab">{tag}</span>}
            <span className="pcard-number">{number}</span>
            <div className="pcard-band">
              <strong style={{ fontSize: nameSize(name || `#${number}`) }}>{name || `#${number}`}</strong>
              {(role || line) && (
                <span className="pcard-meta">
                  {role && <span className="pcard-role">{role}</span>}
                  {line && <span className="pcard-line">{line}</span>}
                </span>
              )}
            </div>
          </div>
        </div>
        {back && (
          <div className="pcard-face pcard-back">
            <div className="pcard-backside">{back}</div>
          </div>
        )}
      </div>
    </div>
  );
}
