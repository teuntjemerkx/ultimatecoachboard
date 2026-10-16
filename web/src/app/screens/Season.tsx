import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { all } from "../store/db";
import { useNav } from "../store/nav";
import { MatchSession, type MatchRecord } from "../match/session";
import { RotationRecord, RotationStats, type RallyRecord } from "../../core/match";

interface MatchLine { id: string; date: string; opponent: string; sets: string; won: boolean | null; sideOut?: number; breakRate?: number }

/** The season: every match, and how each rotation did over all of them. */
export function Season() {
  const go = useNav((s) => s.go);
  const [lines, setLines] = useState<MatchLine[] | null>(null);
  const [rallies, setRallies] = useState<RallyRecord[]>([]);

  useEffect(() => {
    (async () => {
      const recs = (await all<MatchRecord>("matches")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const out: MatchLine[] = [];
      const allRallies: RallyRecord[] = [];
      for (const r of recs) {
        const s = await MatchSession.open(r.id);
        if (!s) continue;
        const rs = s.state.rallies;
        allRallies.push(...rs);
        const recv = rs.filter((x) => x.serving === "opponent"), serve = rs.filter((x) => x.serving === "home");
        out.push({
          id: r.id, date: r.createdAt, opponent: r.opponent, sets: r.sets,
          won: r.finished ? r.setsWon.home > r.setsWon.opponent : null,
          sideOut: recv.length ? recv.filter((x) => x.winner === "home").length / recv.length : undefined,
          breakRate: serve.length ? serve.filter((x) => x.winner === "home").length / serve.length : undefined,
        });
      }
      setLines(out);
      setRallies(allRallies);
    })();
  }, []);

  const pct = (v?: number) => (v === undefined ? "–" : `${Math.round(v * 100)}%`);
  const finished = (lines ?? []).filter((l) => l.won !== null);
  const wins = finished.filter((l) => l.won).length;
  const perRotation = RotationStats.records(rallies, "home");
  const recv = rallies.filter((x) => x.serving === "opponent");

  return (
    <div className="screen">
      <Bar title="Season" />
      <div className="scroll">
        <div className="page stack" style={{ gap: 24, maxWidth: 900 }}>
          {lines === null ? <div className="empty">Reading your matches…</div> : lines.length === 0 ? (
            <div className="empty">Your matches appear here after you keep score in one.
              <button className="btn primary" onClick={() => go({ name: "setup" })}>Start match</button>
            </div>
          ) : (
            <>
              <div className="grid-lockers">
                <Stat title="Matches" value={`${wins}–${finished.length - wins}`} note="won–lost" />
                <Stat title="Side-out" value={pct(recv.length ? recv.filter((x) => x.winner === "home").length / recv.length : undefined)} note="points won on their serve" />
                <Stat title="Break points" value={pct(rallies.filter((x) => x.serving === "home").length ? rallies.filter((x) => x.serving === "home" && x.winner === "home").length / rallies.filter((x) => x.serving === "home").length : undefined)} note="points won on our serve" />
                <Stat title="Rallies" value={String(rallies.length)} note="this season" />
              </div>
              <section>
                <h2 className="group-title">Side-out by rotation, all matches</h2>
                <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, alignItems: "end", height: 190 }}>
                  {[1, 2, 3, 4, 5, 6].map((r) => {
                    const rec = perRotation.find((x) => x.rotation === r);
                    const rate = rec ? RotationRecord.sideOutRate(rec) : undefined;
                    return (
                      <div key={r} className="stack" style={{ gap: 6, alignItems: "center", height: "100%", justifyContent: "flex-end" }}>
                        <span className="mono" style={{ fontSize: 14 }}>{pct(rate)}</span>
                        <div style={{ width: "100%", height: `${Math.max(4, (rate ?? 0) * 100)}%`, background: "var(--c-accent)", borderRadius: 4, boxShadow: "0 -3px 0 var(--c-led) inset" }} />
                        <span className="athletic" style={{ fontSize: 18 }}>R{r}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
              <section>
                <h2 className="group-title">Matches</h2>
                <div className="list">
                  {lines.map((l) => (
                    <button key={l.id} className="btn quiet" style={{ justifyContent: "flex-start", borderRadius: 0 }}
                            onClick={() => go(l.won === null ? { name: "live", matchId: l.id } : { name: "log", matchId: l.id })}>
                      <span className="muted" style={{ width: 64 }}>{new Date(l.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                      <span style={{ flex: 1, textAlign: "left" }}>vs {l.opponent}</span>
                      <span className="mono">{l.sets}</span>
                      <span className="muted" style={{ width: 110, textAlign: "right" }}>side-out {pct(l.sideOut)}</span>
                      <span style={{ width: 70, textAlign: "right", fontWeight: 700, color: l.won === null ? "var(--c-text2)" : l.won ? "var(--c-home)" : "var(--c-opponent)" }}>
                        {l.won === null ? "Playing" : l.won ? "Won" : "Lost"}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <div className="locker" style={{ minHeight: 0, cursor: "default" }}>
      <div className="plate">{title}</div>
      <div className="inside">
        <span style={{ font: "800 44px/1 var(--font-athletic)", color: "var(--c-text)" }}>{value}</span>
        <span>{note}</span>
      </div>
    </div>
  );
}
