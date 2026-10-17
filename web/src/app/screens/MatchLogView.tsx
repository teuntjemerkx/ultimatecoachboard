import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { MatchSession } from "../match/session";
import { MatchLog, RallyRecord, type MatchLogRow } from "../../core/match";

/** Screen 7: every rally of a match, one set at a time: the score after it, who served and who won it. */
export function MatchLogView({ matchId }: { matchId: string }) {
  const [session, setSession] = useState<MatchSession | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  useEffect(() => { MatchSession.open(matchId).then((s) => setSession(s ?? null)); }, [matchId]);
  if (!session) return <div className="screen"><Bar title="Match log" /><div className="empty" style={{ flex: 1 }}>Opening…</div></div>;
  const st = session.state;
  const rows = MatchLog.rows(st, session.records);
  const sets = [...new Set(rows.map((r) => r.rally.setNumber))];
  const set = chosen ?? sets[sets.length - 1];
  const home = st.setup.homeName ?? "Us", away = st.setup.opponentName ?? "Opponent";
  const inSet = rows.filter((r) => r.rally.setNumber === set);
  const last = inSet.length ? RallyRecord.scoreAfter(inSet[inSet.length - 1].rally) : undefined;
  return (
    <div className="screen">
      <Bar title={`${home} vs ${away}`} />
      {rows.length === 0 ? <div className="empty" style={{ flex: 1 }}>No rallies yet.</div> : (
        <main className="fill" style={{ gridTemplateRows: "auto minmax(0, 1fr)" }}>
          <div className="row" style={{ gap: 10 }}>
            {sets.map((n) => (
              <button key={n} className={`btn big ${n === set ? "on" : ""}`} aria-pressed={n === set} onClick={() => setChosen(n)}
                      style={{ font: "800 22px/1 var(--font-athletic)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Set {n}</button>
            ))}
            {last && <span className="nameplate" style={{ marginLeft: "auto", fontSize: 24 }}>{last.home} – {last.opponent}</span>}
          </div>
          <section className="locker-card">
            <div className="plate-head">
              <span className="plate">Set {set}</span>
              <span className="aside">{inSet.length} rallies</span>
            </div>
            <div className="card-body">
              <div className="rally-grid">
                {inSet.map((r: MatchLogRow) => {
                  const after = RallyRecord.scoreAfter(r.rally);
                  const won = r.rally.winner === "home";
                  return (
                    <div key={r.rally.seq} className="rally" style={{ ["--team" as string]: won ? "var(--c-home)" : "var(--c-opponent)" }}
                         aria-label={`${after.home}–${after.opponent}, ${won ? "won" : "lost"}, ${r.rally.serving === "home" ? "we served" : "they served"}, rotation ${r.rally.homeRotation}`}>
                      <strong>{after.home}–{after.opponent}</strong>
                      <span>{r.rally.serving === "home" ? "Our serve" : "Their serve"} · R{r.rally.homeRotation}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
