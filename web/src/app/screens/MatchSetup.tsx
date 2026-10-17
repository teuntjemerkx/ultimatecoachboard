import { useEffect, useRef, useState } from "react";
import { Bar } from "../ui/Bar";
import { Choice } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { all } from "../store/db";
import { useNav } from "../store/nav";
import { netHeight, useSettings } from "../store/settings";
import { TeamSystem, type Side } from "../../core/match";
import { MatchSession, useMatch, type PlayerRef } from "../match/session";
import { roleChip, seasonOf, type Player } from "./Players";
import { PrizmCard } from "../ui/PrizmCard";
import { useFitColumns } from "../hooks/useViewport";
import { useSchedule } from "../schedule/useSchedule";
import { fixture, ourTeam, upcoming, when, type ScheduledMatch } from "../schedule/schedule";

/** A scheduled match counts as today's from 12 hours before the start (the coach sets up at the hall). */
const scheduleWindow = 12 * 3600 * 1000;

const SETUP_KEY = "coachboard.lastSetup";

/** Positions as they stand on court, seen from behind our end line: the front row at the net. */
const layout = [[4, 3, 2], [5, 6, 1]];

/** Screen 2: six players on their positions, who serves, and go. Remembers the last lineup. */
export function MatchSetup() {
  const go = useNav((s) => s.go);
  const route = useNav((s) => s.route);
  const open = useMatch((s) => s.open);
  const settings = useSettings();
  const schedule = useSchedule((s) => s.schedule);
  const team = schedule ? ourTeam(schedule) : undefined;
  const coming = upcoming(schedule).filter((m) => !m.cancelled).slice(0, 3);
  const opponentOf = (m: ScheduledMatch) => fixture(m, team).opponent ?? m.title;
  const [roster, setRoster] = useState<Player[]>([]);
  const last = (() => { try { return JSON.parse(localStorage.getItem(SETUP_KEY) ?? "null"); } catch { return null; } })();
  // The match tapped on the start screen, else a scheduled match about to start, else the last opponent.
  const scheduled = (route.name === "setup" && route.scheduled ? schedule?.matches.find((m) => m.id === route.scheduled) : undefined)
    ?? coming.find((m) => Date.parse(m.start) - Date.now() < scheduleWindow);
  const [opponent, setOpponent] = useState<string>(scheduled ? opponentOf(scheduled) : last?.opponentName ?? "");
  const [system, setSystem] = useState<TeamSystem>(last?.system ?? TeamSystem.fiveOneOutside);
  const [slots, setSlots] = useState<(PlayerRef | null)[]>(last?.slots ?? [null, null, null, null, null, null]);
  const [libero, setLibero] = useState<PlayerRef | undefined>(last?.libero);
  const [setter, setSetter] = useState<number>(last?.setterPosition ?? 1);
  const [firstServer, setFirstServer] = useState<Side>("home");
  const [picking, setPicking] = useState<number | "libero" | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { all<Player>("players").then((p) => setRoster(p.sort((a, b) => a.number - b.number))); }, []);

  const used = new Set([...slots.filter(Boolean).map((p) => p!.number), ...(libero ? [libero.number] : [])]);
  const ready = slots.every(Boolean);
  const hasSetter = TeamSystem.hasSetter(system);

  function place(p: PlayerRef) {
    let following: number | null = null;
    if (picking === "libero") setLibero(p);
    else if (typeof picking === "number") {
      const next = slots.map((s) => (s?.number === p.number ? null : s));
      next[picking - 1] = p;
      setSlots(next);
      if (libero?.number === p.number) setLibero(undefined);
      // Straight on to the next empty position (1 to 6, after this one), so six taps fill the lineup.
      for (let k = 1; k < 6 && following === null; k++) {
        const pos = ((picking - 1 + k) % 6) + 1;
        if (!next[pos - 1]) following = pos;
      }
    }
    setPicking(following);
    setTyped("");
  }

  async function start() {
    if (!ready) return setError("Put six players on court.");
    const setup = {
      homeName: settings.teamName || "Us", opponentName: opponent.trim() || "Opponent", system, slots, libero,
      bench: roster.filter((r) => !used.has(r.number)).map((r) => ({ id: r.id.toUpperCase(), number: r.number, name: r.name || undefined })),
      setterPosition: setter, opponentNumbers: [null, null, null, null, null, null], opponentSetterPosition: 1, firstServer,
      netHeight: netHeight(settings.women), mode: settings.advanced ? "advanced" as const : "solo" as const,
    };
    try { localStorage.setItem(SETUP_KEY, JSON.stringify({ opponentName: setup.opponentName, system, slots, libero, setterPosition: setter })); } catch { /* ignore */ }
    try {
      const session = await MatchSession.start(setup);
      open(session);
      go({ name: "live", matchId: session.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The match could not start.");
    }
  }

  const line = `${settings.teamName || "Your team"} · ${seasonOf()}`;
  const systemLabel = (sys: TeamSystem): [string, string] => {
    const [main, ...rest] = TeamSystem.displayName(sys).split(" · ");
    return [main, rest.join(" ").replace(" setter", "")];
  };

  return (
    <div className="screen">
      <Bar title="New match" />
      <main className="fill setup-fill">
        <section className="locker-card">
          <div className="plate-head">
            <span className="plate"><Icon name="court" size={20} /> Our lineup</span>
            <span className="aside">{slots.filter(Boolean).length} of 6</span>
          </div>
          <div className="card-body">
            <div className="lineup">
              <div className="stack" style={{ gap: 6 }}>
                <span className="label" style={{ textAlign: "center" }}>Net</span>
                <div className="net" />
              </div>
              {layout.map((row, r) => (
                <div key={r} className="lineup-row">
                  {row.map((pos) => {
                    const p = slots[pos - 1];
                    return (
                      <button key={pos} className={`slot${p ? " filled" : ""}${picking === pos ? " picking" : ""}`} onClick={() => setPicking(pos)}
                              style={p ? { ["--foil" as string]: `${(p.number * 37) % 100}%`, ["--turn" as string]: `${210 + ((p.number * 47) % 360)}deg` } : undefined}
                              aria-label={p ? `Position ${pos}: number ${p.number}` : `Position ${pos}: choose a player`}>
                        <span className="pos">Position {pos}</span>
                        <span className="no">{p ? p.number : <Icon name="plus" size={40} />}</span>
                        {hasSetter && p && setter === pos && <span className="tag">Setter</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: hasSetter ? "auto 1fr" : "1fr", gap: 14, alignItems: "end" }}>
              <button className={`btn big ${libero ? "on" : "secondary"}`} onClick={() => setPicking("libero")} style={{ minWidth: 150 }}>
                Libero {libero ? `#${libero.number}` : <Icon name="plus" />}
              </button>
              {hasSetter && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="label">Setter in position</span>
                  <div className="seg6" role="group" aria-label="Setter in position">
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <button key={n} className={`btn ${setter === n ? "on" : ""}`} aria-pressed={setter === n} onClick={() => setSetter(n)}>{n}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="locker-card">
          <div className="plate-head"><span className="plate"><Icon name="whistle" size={20} /> The match</span></div>
          <div className="card-body">
            <label className="field">
              <span className="label">Opponent</span>
              <input id="opponent-name" value={opponent} placeholder="Dynamo" onChange={(e) => setOpponent(e.target.value)} />
            </label>
            {coming.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <span className="label">From the schedule</span>
                <div className="chip-grid">
                  {coming.map((m) => {
                    const name = opponentOf(m);
                    return (
                      <button key={m.id} type="button" className={`btn ${opponent === name ? "on" : ""}`}
                              aria-pressed={opponent === name} onClick={() => setOpponent(name)}>
                        <span>{name}</span>
                        <small>{when(m)}{fixture(m, team).home === undefined ? "" : fixture(m, team).home ? " · home" : " · away"}</small>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Team system</span>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${TeamSystem.allCases.length}, 1fr)`, gap: 8 }} role="group" aria-label="Team system">
                {TeamSystem.allCases.map((sys) => {
                  const [main, sub] = systemLabel(sys);
                  return (
                    <button key={sys} type="button" className={`btn ${system === sys ? "on" : ""}`} aria-pressed={system === sys}
                            onClick={() => setSystem(sys)} title={TeamSystem.displayName(sys)}
                            style={{ minHeight: 64, flexDirection: "column", gap: 2, padding: "4px 6px", whiteSpace: "normal", borderRadius: 18 }}>
                      <span style={{ font: `400 ${main.length > 4 ? 24 : 28}px/1 var(--font-display-big)`, whiteSpace: "nowrap" }}>{main}</span>
                      {sub && <small style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, lineHeight: 1.1 }}>{sub}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Who serves first?</span>
              <Choice label="Who serves first" value={firstServer} onChange={setFirstServer}
                      options={[{ value: "home", title: "Us" }, { value: "opponent", title: "Them" }]} />
            </div>
            <div className="stack" style={{ gap: 8, marginTop: "auto" }}>
              {error && <p role="alert" style={{ margin: 0, color: "var(--c-fault)", fontWeight: 600 }}>{error}</p>}
              <button className="btn primary wide" disabled={!ready} onClick={start}><Icon name="play" /> Start match</button>
              <p className="muted" style={{ margin: 0, textAlign: "center" }}>
                {ready ? `Net ${netHeight(settings.women).toFixed(2)} m (${settings.women ? "women" : "men"}; change in Settings).` : `Put 6 players on court (${slots.filter(Boolean).length} of 6).`}
              </p>
            </div>
          </div>
        </section>
      </main>

      {picking !== null && (
        <PickSheet title={picking === "libero" ? "Who is the libero?" : `Who plays position ${picking}?`} roster={roster}
                   onCourt={(n) => slots.some((s) => s?.number === n)} libero={libero?.number} line={line}
                   typed={typed} setTyped={setTyped} onPick={place} onClose={() => setPicking(null)} />
      )}
    </div>
  );
}

/**
 * Picking a player: the team as cards, filling the sheet (no scrolling); a player already on court shows chrome, the
 * libero gold. A number typed in works for a player not in the team.
 */
function PickSheet({ title, roster, onCourt, libero, line, typed, setTyped, onPick, onClose }: {
  title: string; roster: Player[]; onCourt: (n: number) => boolean; libero?: number; line: string;
  typed: string; setTyped: (t: string) => void; onPick: (p: PlayerRef) => void; onClose: () => void;
}) {
  const rack = useRef<HTMLDivElement>(null);
  const fit = useFitColumns(rack, roster.length);
  return (
    <div className="sheet" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card stack pick-sheet" style={{ gap: 16 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="group-title" style={{ margin: 0, fontSize: 40 }}>{title}</h2>
          <button className="btn big secondary" type="button" onClick={onClose}><Icon name="close" /> Cancel</button>
        </div>
        {roster.length > 0 && (
          <div className="card-rack" ref={rack}
               style={{ flex: 1, gridTemplateColumns: fit.width ? `repeat(${fit.cols}, ${fit.width}px)` : undefined, justifyContent: "center", overflow: fit.width ? "hidden" : "auto" }}>
            {roster.map((r) => {
              const court = onCourt(r.number), isLibero = libero === r.number;
              return (
                <PrizmCard key={r.id} number={r.number} name={r.name} role={roleChip(r.role)} line={line}
                           tier={isLibero ? "gold" : court ? "chrome" : "prizm"} tag={isLibero ? "Libero" : court ? "On court" : undefined}
                           label={`#${r.number}${r.name ? ` ${r.name}` : ""}${court ? " (on court)" : isLibero ? " (libero)" : ""}`}
                           onSelect={() => onPick({ id: r.id.toUpperCase(), number: r.number, name: r.name || undefined })} />
              );
            })}
          </div>
        )}
        <form className="row" onSubmit={(e) => { e.preventDefault(); const n = Number(typed); if (typed.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 99) onPick({ id: crypto.randomUUID().toUpperCase(), number: n }); }}>
          <span className="label">{roster.length ? "Not in the team?" : "Shirt number"}</span>
          <input id="type-number" className="input" inputMode="numeric" placeholder="#" value={typed} onChange={(e) => setTyped(e.target.value)}
                 style={{ width: 120, font: "400 34px/1 var(--font-display-big)", textAlign: "center" }} />
          <button className="btn big" type="submit">Use this number</button>
        </form>
      </div>
    </div>
  );
}
