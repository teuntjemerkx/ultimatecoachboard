import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { Choice } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { all } from "../store/db";
import { useNav } from "../store/nav";
import { netHeight, useSettings } from "../store/settings";
import { TeamSystem, type Side } from "../../core/match";
import { MatchSession, useMatch, type PlayerRef } from "../match/session";
import type { Player } from "./Players";

const SETUP_KEY = "coachboard.lastSetup";

/** Positions as they stand on court, seen from behind our end line: the front row at the net. */
const layout = [[4, 3, 2], [5, 6, 1]];

/** Screen 2: six players on their positions, who serves, and go. Remembers the last lineup. */
export function MatchSetup() {
  const go = useNav((s) => s.go);
  const open = useMatch((s) => s.open);
  const settings = useSettings();
  const [roster, setRoster] = useState<Player[]>([]);
  const last = (() => { try { return JSON.parse(localStorage.getItem(SETUP_KEY) ?? "null"); } catch { return null; } })();
  const [opponent, setOpponent] = useState<string>(last?.opponentName ?? "");
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
    if (picking === "libero") setLibero(p);
    else if (typeof picking === "number") {
      const next = slots.map((s) => (s?.number === p.number ? null : s));
      next[picking - 1] = p;
      setSlots(next);
      if (libero?.number === p.number) setLibero(undefined);
    }
    setPicking(null);
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

  return (
    <div className="screen">
      <Bar title="New match" />
      <div className="scroll">
        <div className="page" style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", alignItems: "start" }}>
          <section className="stack">
            <h2 className="group-title">Our lineup</h2>
            <div className="card stack" style={{ gap: 10 }}>
              <div className="label" style={{ textAlign: "center" }}>Net</div>
              <div style={{ height: 4, background: "var(--c-net)", borderRadius: 2 }} />
              {layout.map((row, r) => (
                <div key={r} style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                  {row.map((pos) => {
                    const p = slots[pos - 1];
                    return (
                      <button key={pos} className="btn" onClick={() => setPicking(pos)}
                              style={{ minHeight: 92, flexDirection: "column", gap: 2, border: "1.5px solid var(--c-hairline)", background: picking === pos ? "color-mix(in srgb, var(--c-led) 14%, var(--c-surface))" : "var(--c-surface)" }}>
                        <span className="label">Position {pos}</span>
                        <span style={{ font: "800 34px/1 var(--font-athletic)" }}>{p ? p.number : "+"}</span>
                        {hasSetter && p && setter === pos && <span className="label" style={{ color: "var(--c-home)" }}>Setter</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="row">
                <button className="btn secondary" onClick={() => setPicking("libero")}>Libero {libero ? libero.number : "+"}</button>
                {hasSetter && (
                  <label className="row" style={{ gap: 8 }}>
                    <span className="muted">Setter in position</span>
                    <select id="setter-position" value={setter} onChange={(e) => setSetter(Number(e.target.value))}
                            style={{ minHeight: 44, borderRadius: 6, padding: "0 10px", border: "1px solid var(--c-hairline)", background: "var(--c-bg)" }}>
                      {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
            {picking !== null && (
              <div className="card stack" style={{ gap: 12 }}>
                <strong>{picking === "libero" ? "Who is the libero?" : `Who plays position ${picking}?`}</strong>
                {roster.length > 0 && (
                  <div className="row" style={{ gap: 8 }}>
                    {roster.map((r) => (
                      <button key={r.id} className={`btn small ${used.has(r.number) ? "" : "secondary"}`} style={{ minWidth: 56, minHeight: 48, fontSize: 20, fontWeight: 800 }}
                              onClick={() => place({ id: r.id.toUpperCase(), number: r.number, name: r.name || undefined })}>
                        {r.number}
                      </button>
                    ))}
                  </div>
                )}
                <form className="row" onSubmit={(e) => { e.preventDefault(); const n = Number(typed); if (Number.isInteger(n) && n >= 0 && n <= 99) place({ id: crypto.randomUUID().toUpperCase(), number: n }); }}>
                  <input id="type-number" inputMode="numeric" placeholder="Number" value={typed} onChange={(e) => setTyped(e.target.value)}
                         style={{ width: 120, minHeight: 44, borderRadius: 6, border: "1px solid var(--c-hairline)", padding: "0 12px", background: "var(--c-bg)" }} />
                  <button className="btn secondary" type="submit">Use this number</button>
                  <button className="btn quiet" type="button" onClick={() => setPicking(null)}>Cancel</button>
                </form>
              </div>
            )}
          </section>

          <section className="stack" style={{ gap: 20 }}>
            <label className="field">
              <span className="label">Opponent</span>
              <input id="opponent-name" value={opponent} placeholder="Dynamo" onChange={(e) => setOpponent(e.target.value)} />
            </label>
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Team system</span>
              <select id="team-system" value={system} onChange={(e) => setSystem(e.target.value as TeamSystem)}
                      style={{ minHeight: 48, borderRadius: 6, padding: "0 12px", border: "1px solid var(--c-hairline)", background: "var(--c-bg)", fontSize: 17 }}>
                {TeamSystem.allCases.map((s) => <option key={s} value={s}>{TeamSystem.displayName(s)}</option>)}
              </select>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Who serves first?</span>
              <Choice label="Who serves first" value={firstServer} onChange={setFirstServer}
                      options={[{ value: "home", title: "Us" }, { value: "opponent", title: "Them" }]} />
            </div>
            <p className="muted" style={{ margin: 0 }}>Net {netHeight(settings.women).toFixed(2)} m ({settings.women ? "women" : "men"}; change in Settings).</p>
            {error && <p role="alert" style={{ margin: 0, color: "var(--c-fault)" }}>{error}</p>}
            <button className="btn primary" disabled={!ready} onClick={start}><Icon name="play" /> Start match</button>
            {!ready && <p className="muted" style={{ margin: 0 }}>Put 6 players on court ({slots.filter(Boolean).length} of 6).</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
