import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { MatchSession } from "../match/session";
import { MatchLog, RallyRecord, type MatchLogRow } from "../../core/match";

/** Screen 7: every rally of a match, set by set. */
export function MatchLogView({ matchId }: { matchId: string }) {
  const [session, setSession] = useState<MatchSession | null>(null);
  useEffect(() => { MatchSession.open(matchId).then((s) => setSession(s ?? null)); }, [matchId]);
  if (!session) return <div className="screen"><Bar title="Match log" /><div className="empty">Opening…</div></div>;
  const st = session.state;
  const rows = MatchLog.rows(st, session.records);
  const sets = [...new Set(rows.map((r) => r.rally.setNumber))];
  const home = st.setup.homeName ?? "Us", away = st.setup.opponentName ?? "Opponent";
  return (
    <div className="screen">
      <Bar title={`${home} vs ${away}`} />
      <div className="scroll">
        <div className="page stack" style={{ gap: 24, maxWidth: 820 }}>
          {rows.length === 0 && <div className="empty">No rallies yet.</div>}
          {sets.map((n) => (
            <section key={n}>
              <h2 className="group-title">Set {n}</h2>
              <div className="list">
                {rows.filter((r) => r.rally.setNumber === n).map((r: MatchLogRow) => {
                  const after = RallyRecord.scoreAfter(r.rally);
                  const won = r.rally.winner === "home";
                  return (
                    <div key={r.rally.seq}>
                      <span className="mono" style={{ fontWeight: 700, width: 64 }}>{after.home}–{after.opponent}</span>
                      <span style={{ flex: 1 }}>{r.rally.serving === "home" ? "We served" : "They served"} · Rotation {r.rally.homeRotation}</span>
                      <span style={{ fontWeight: 700, color: won ? "var(--c-home)" : "var(--c-opponent)" }}>{won ? "Won" : "Lost"}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
