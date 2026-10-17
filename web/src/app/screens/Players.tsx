import { useEffect, useRef, useState } from "react";
import { Bar } from "../ui/Bar";
import { Icon } from "../ui/Icon";
import { all, put, remove } from "../store/db";
import { useSettings } from "../store/settings";
import { PrizmCard } from "../ui/PrizmCard";
import { useFitColumns } from "../hooks/useViewport";

export interface Player { id: string; number: number; name: string; role: string; height?: number }

export const roles: { value: string; title: string }[] = [
  { value: "S", title: "Setter" }, { value: "OH", title: "Outside" }, { value: "MB", title: "Middle" },
  { value: "OPP", title: "Opposite" }, { value: "L", title: "Libero" }, { value: "", title: "Any" },
];

/** "25/26": the season a date falls in (a season starts in August). */
export function seasonOf(d = new Date()): string {
  const y = d.getFullYear() % 100, start = d.getMonth() >= 7 ? y : y - 1;
  return `${String(start).padStart(2, "0")}/${String((start + 1) % 100).padStart(2, "0")}`;
}

/** A player's role as the card's short chip ("OH"), or nothing for "any". */
export const roleChip = (role: string) => role || undefined;

/**
 * The team as trading cards: a tap turns a card over (its facts, and Edit). Adding and changing on the right, with the
 * card filling in as you type.
 */
export function Players() {
  const advanced = useSettings((s) => s.advanced);
  const teamName = useSettings((s) => s.teamName);
  const [players, setPlayers] = useState<Player[]>([]);
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [height, setHeight] = useState("");
  const [error, setError] = useState("");
  /** The card being changed in the form, else the form makes a new one. */
  const [editing, setEditing] = useState<Player | null>(null);
  const [removing, setRemoving] = useState(false);
  const line = `${teamName || "Your team"} · ${seasonOf()}`;
  const rack = useRef<HTMLDivElement>(null);
  const fit = useFitColumns(rack, players.length);

  const reload = () => all<Player>("players").then((p) => setPlayers(p.sort((a, b) => a.number - b.number)));
  useEffect(() => { reload(); }, []);
  // An armed Remove goes back to safe after a few seconds.
  useEffect(() => {
    if (!removing) return;
    const t = setTimeout(() => setRemoving(false), 4000);
    return () => clearTimeout(t);
  }, [removing]);

  function reset() {
    setNumber(""); setName(""); setHeight(""); setError(""); setEditing(null); setRemoving(false);
  }

  function edit(p: Player) {
    setEditing(p);
    setNumber(String(p.number)); setName(p.name); setRole(p.role); setHeight(p.height ? p.height.toFixed(2) : "");
    setError(""); setRemoving(false);
  }

  async function save() {
    const n = Number(number);
    if (number.trim() === "" || !Number.isInteger(n) || n < 0 || n > 99) return setError("Use a number from 0 to 99.");
    if (players.some((p) => p.number === n && p.id !== editing?.id)) return setError(`#${n} is already on the team.`);
    const h = height ? Number(height.replace(",", ".")) : undefined;
    if (h !== undefined && !(h >= 1.2 && h <= 2.25)) return setError("Height must be between 1.20 and 2.25 m.");
    const player: Player = { id: editing?.id ?? crypto.randomUUID(), number: n, name: name.trim(), role, height: h ?? (advanced ? undefined : editing?.height) };
    // The form empties before the write, so the next player can be typed at once without losing letters.
    reset();
    await put<Player>("players", player);
    reload();
  }

  async function removeEditing() {
    if (!editing) return;
    if (!removing) return setRemoving(true);
    const id = editing.id;
    reset();
    await remove("players", id);
    reload();
  }

  // A button on a card's back acts without turning the card over again.
  const keep = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onPointerUp: (e: React.PointerEvent) => e.stopPropagation() };

  return (
    <div className="screen">
      <Bar title="Players" />
      <main className="fill players-fill">
        <section className="locker-card">
          <div className="plate-head">
            <span className="plate"><Icon name="shirt" size={20} /> The team</span>
            <span className="aside">{players.length} {players.length === 1 ? "card" : "cards"} · tap to turn over</span>
          </div>
          <div className="card-body">
            {players.length === 0 ? (
              <div className="empty" style={{ flex: 1 }}>
                <Icon name="shirt" size={64} className="locker-icon" />
                Add your players by shirt number. Names and roles are optional.
              </div>
            ) : (
              <div className="card-rack" ref={rack}
                   style={{ gridTemplateColumns: fit.width ? `repeat(${fit.cols}, ${fit.width}px)` : undefined, justifyContent: "center", flex: 1, overflow: fit.width ? "hidden" : "auto" }}>
                {players.map((p) => {
                  const roleName = roles.find((r) => r.value === p.role)?.title ?? "Any";
                  return (
                    <PrizmCard key={p.id} number={p.number} name={p.name} role={roleChip(p.role)} line={line}
                               back={(
                                 <>
                                   <span className="eyebrow">Back</span>
                                   <h3>#{p.number} {p.name}</h3>
                                   <div className="facts">
                                     <div><span>Role</span><b>{roleName}</b></div>
                                     {p.height && <div><span>Height</span><b>{p.height.toFixed(2)} m</b></div>}
                                   </div>
                                   <button className="btn secondary" {...keep} onClick={() => edit(p)}>
                                     <Icon name="pen" /> Edit
                                   </button>
                                 </>
                               )} />
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <form className="locker-card" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="plate-head">
            <span className="plate"><Icon name={editing ? "pen" : "plus"} size={20} /> {editing ? `Edit #${editing.number}` : "New card"}</span>
          </div>
          <div className="card-body">
            <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 16, alignItems: "start" }}>
              <PrizmCard number={number.trim() === "" ? "?" : number.trim()} name={name.trim()} role={roleChip(role)} line={line}
                         tier={number.trim() === "" ? "base" : "prizm"} label={editing ? "The card you are changing" : "The new card"} />
              <div className="stack" style={{ gap: 12 }}>
                <label className="field">
                  <span className="label">Number</span>
                  <input id="player-number" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="7"
                         style={{ font: "400 36px/1 var(--font-display-big)", textAlign: "center" }} />
                </label>
                <label className="field">
                  <span className="label">Name (optional)</span>
                  <input id="player-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sanne" />
                </label>
              </div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Role</span>
              <div className="role-chips" role="group" aria-label="Role">
                {roles.map((r) => (
                  <button key={r.value} type="button" className={`btn ${role === r.value ? "on" : ""}`} aria-pressed={role === r.value}
                          onClick={() => setRole(r.value)}>{r.title}</button>
                ))}
              </div>
            </div>
            {advanced && (
              <label className="field">
                <span className="label">Height (m)</span>
                <input id="player-height" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="1.82" />
              </label>
            )}
            {error && <p role="alert" style={{ margin: 0, color: "var(--c-fault)", fontWeight: 600 }}>{error}</p>}
            {editing ? (
              <div className="stack" style={{ gap: 10, marginTop: "auto" }}>
                <button className="btn primary wide" type="submit"><Icon name="check" /> Save changes</button>
                <div className="row" style={{ gap: 10 }}>
                  <button className="btn big secondary" type="button" style={{ flex: 1 }} onClick={reset}>Cancel</button>
                  <button className={`btn big ${removing ? "danger" : "secondary"}`} type="button" style={{ flex: 1 }} onClick={removeEditing}>
                    <Icon name="trash" /> {removing ? "Tap again" : "Remove"}
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn primary wide" type="submit" style={{ marginTop: "auto" }}><Icon name="plus" /> Add player</button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
