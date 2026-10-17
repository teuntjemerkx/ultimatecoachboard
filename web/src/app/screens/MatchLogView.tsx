import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { Icon } from "../ui/Icon";
import { remove } from "../store/db";
import { useNav } from "../store/nav";
import { MatchSession, useMatch } from "../match/session";
import { MatchLog, RallyRecord, type MatchLogRow } from "../../core/match";

/**
 * Screen 7: every rally of a match, one set at a time: the score after it, who served and who won it. From here the
 * coach goes back to a match still being played, or deletes one (a test, a match that never finished).
 */
export function MatchLogView({ matchId }: { matchId: string }) {
  const go = useNav((s) => s.go);
  const [session, setSession] = useState<MatchSession | null | "missing">(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { MatchSession.open(matchId).then((s) => setSession(s ?? "missing"), () => setSession("missing")); }, [matchId]);
  // An armed Delete goes back to safe after a few seconds.
  useEffect(() => {
    if (!deleting) return;
    const t = setTimeout(() => setDeleting(false), 4000);
    return () => clearTimeout(t);
  }, [deleting]);

  async function del() {
    if (!deleting) return setDeleting(true);
    await remove("matches", matchId);
    // The live screen must not keep the deleted match open (and save it again).
    if (useMatch.getState().session?.id === matchId) useMatch.setState({ session: undefined });
    go({ name: "home" });
  }
  const deleteBtn = (
    <button className={`btn ${deleting ? "danger" : "secondary"}`} style={{ marginLeft: "auto" }} onClick={del}>
      <Icon name="trash" /> {deleting ? "Tap again to delete" : "Delete match"}
    </button>
  );

  if (session === "missing") return <div className="screen"><Bar title="Match log">{deleteBtn}</Bar><div className="empty" style={{ flex: 1 }}>This match could not be opened.</div></div>;
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
      <Bar title={`${home} vs ${away}`}>
        {deleteBtn}
        {!st.match.isOver && <button className="btn primary" onClick={() => go({ name: "live", matchId })}><Icon name="play" /> Back to match</button>}
      </Bar>
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
