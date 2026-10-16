import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { Icon } from "../ui/Icon";
import { all, put, remove } from "../store/db";
import { useSettings } from "../store/settings";

export interface Player { id: string; number: number; name: string; role: string; height?: number }

export const roles: { value: string; title: string }[] = [
  { value: "S", title: "Setter" }, { value: "OH", title: "Outside" }, { value: "MB", title: "Middle" },
  { value: "OPP", title: "Opposite" }, { value: "L", title: "Libero" }, { value: "", title: "Any" },
];

/** The team: numbers first (that is how a coach thinks on match day), names and roles as they come. */
export function Players() {
  const advanced = useSettings((s) => s.advanced);
  const [players, setPlayers] = useState<Player[]>([]);
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [height, setHeight] = useState("");
  const [error, setError] = useState("");

  const reload = () => all<Player>("players").then((p) => setPlayers(p.sort((a, b) => a.number - b.number)));
  useEffect(() => { reload(); }, []);

  async function add() {
    const n = Number(number);
    if (!Number.isInteger(n) || n < 0 || n > 99) return setError("Use a number from 0 to 99.");
    if (players.some((p) => p.number === n)) return setError(`#${n} is already on the team.`);
    const h = height ? Number(height.replace(",", ".")) : undefined;
    if (h !== undefined && !(h >= 1.2 && h <= 2.25)) return setError("Height must be between 1.20 and 2.25 m.");
    await put<Player>("players", { id: crypto.randomUUID(), number: n, name: name.trim(), role, height: h });
    setNumber(""); setName(""); setHeight(""); setError("");
    reload();
  }

  return (
    <div className="screen">
      <Bar title="Players" />
      <div className="scroll">
        <div className="page stack" style={{ gap: 24, maxWidth: 820 }}>
          <form className="card stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); add(); }}>
            <h2 className="group-title" style={{ margin: 0 }}>Add a player</h2>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="field" style={{ width: 96 }}>
                <span className="label">Number</span>
                <input id="player-number" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="7" />
              </label>
              <label className="field" style={{ flex: 1, minWidth: 160 }}>
                <span className="label">Name (optional)</span>
                <input id="player-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sanne" />
              </label>
              <label className="field" style={{ width: 150 }}>
                <span className="label">Role</span>
                <select id="player-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  {roles.map((r) => <option key={r.value} value={r.value}>{r.title}</option>)}
                </select>
              </label>
              {advanced && (
                <label className="field" style={{ width: 110 }}>
                  <span className="label">Height (m)</span>
                  <input id="player-height" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="1.82" />
                </label>
              )}
              <button className="btn primary" type="submit"><Icon name="plus" /> Add player</button>
            </div>
            {error && <p role="alert" style={{ margin: 0, color: "var(--c-fault)" }}>{error}</p>}
          </form>

          {players.length === 0 ? (
            <div className="empty">Add your players by number. Names and roles are optional.</div>
          ) : (
            <div className="list">
              {players.map((p) => (
                <div key={p.id}>
                  <span className="mono" style={{ fontSize: 24, fontWeight: 700, width: 48 }}>{p.number}</span>
                  <span style={{ flex: 1 }}>{p.name || <span className="muted">No name</span>}</span>
                  <span className="muted">{roles.find((r) => r.value === p.role)?.title}</span>
                  {advanced && p.height && <span className="mono muted">{p.height.toFixed(2)} m</span>}
                  <button className="btn quiet small danger" aria-label={`Remove #${p.number}`}
                          onClick={async () => { await remove("players", p.id); reload(); }}>
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
