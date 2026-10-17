import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { Icon } from "../ui/Icon";
import { all } from "../store/db";
import { useNav } from "../store/nav";
import { usePortrait } from "../hooks/useViewport";
import { MatchSession, type MatchRecord } from "../match/session";
import { RotationRecord, RotationStats, type RallyRecord } from "../../core/match";

interface MatchLine { id: string; date: string; opponent: string; sets: string; won: boolean | null; sideOut?: number; breakRate?: number }

/** The season on one screen: four numbers, side-out per rotation, and the matches a page at a time. */
export function Season() {
  const go = useNav((s) => s.go);
  const portrait = usePortrait();
  const [lines, setLines] = useState<MatchLine[] | null>(null);
  const [rallies, setRallies] = useState<RallyRecord[]>([]);
  const [page, setPage] = useState(0);

  useEffect(() => {
    (async () => {
      const recs = (await all<MatchRecord>("matches")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const out: MatchLine[] = [];
      const allRallies: RallyRecord[] = [];
      for (const r of recs) {
        // One damaged match must not blank the season: it is left out.
        const s = await MatchSession.open(r.id).catch(() => undefined);
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
    })().catch(() => setLines([]));
  }, []);

  if (lines === null || lines.length === 0) {
    return (
      <div className="screen">
        <Bar title="Season" />
        <div className="empty" style={{ flex: 1 }}>
          {lines === null ? "Reading your matches…" : (
            <>
              <Icon name="trophy" size={72} className="locker-icon" />
              Your matches appear here after you keep score in one.
              <button className="btn primary" onClick={() => go({ name: "setup" })}><Icon name="play" /> Start match</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const pct = (v?: number) => (v === undefined ? "–" : `${Math.round(v * 100)}%`);
  const rate = (xs: RallyRecord[]) => (xs.length ? xs.filter((x) => x.winner === "home").length / xs.length : undefined);
  const finished = lines.filter((l) => l.won !== null);
  const wins = finished.filter((l) => l.won).length;
  const perRotation = RotationStats.records(rallies, "home");
  const perPage = portrait ? 4 : 5;
  const pages = Math.max(1, Math.ceil(lines.length / perPage));
  // Turning the iPad changes the page size; stay on a page that exists.
  const at = Math.min(page, pages - 1);
  const shown = lines.slice(at * perPage, at * perPage + perPage);

  return (
    <div className="screen">
      <Bar title="Season" />
      <main className="fill season-fill">
        <Stat area="a" title="Matches" value={`${wins}–${finished.length - wins}`} note="won – lost" />
        <Stat area="b" title="Side-out" value={pct(rate(rallies.filter((x) => x.serving === "opponent")))} note="points won on their serve" />
        <Stat area="c" title="Break points" value={pct(rate(rallies.filter((x) => x.serving === "home")))} note="points won on our serve" />
        <Stat area="d" title="Rallies" value={String(rallies.length)} note="this season" />

        <section className="locker-card" style={{ gridArea: "chart" }}>
          <div className="plate-head"><span className="plate">Side-out by rotation</span><span className="aside">all matches</span></div>
          <div className="card-body">
            <div className="bars">
              {[1, 2, 3, 4, 5, 6].map((r) => {
                const rec = perRotation.find((x) => x.rotation === r);
                const v = rec ? RotationRecord.sideOutRate(rec) : undefined;
                return (
                  <div key={r}>
                    <span style={{ font: "800 22px/1 var(--font-athletic)" }}>{pct(v)}</span>
                    <div className="bar-fill" style={{ height: `${Math.max(4, (v ?? 0) * 100)}%`, opacity: v === undefined ? 0.25 : 1 }} />
                    <span className="label" style={{ color: "var(--c-text)" }}>R{r}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="locker-card" style={{ gridArea: "list" }}>
          <div className="plate-head"><span className="plate">Matches</span><span className="aside">{lines.length}</span></div>
          <div className="card-body" style={{ justifyContent: "space-between" }}>
            <div className="stack" style={{ gap: 10 }}>
              {shown.map((l) => (
                <button key={l.id} className="match-row" onClick={() => go(l.won === null ? { name: "live", matchId: l.id } : { name: "log", matchId: l.id })}>
                  <span className="date">{new Date(l.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                  <span className="who">vs {l.opponent}</span>
                  <span className="sets">{l.sets}</span>
                  <span className={`badge ${l.won === null ? "" : l.won ? "won" : "lost"}`}>{l.won === null ? "Playing" : l.won ? "Won" : "Lost"}</span>
                </button>
              ))}
            </div>
            {pages > 1 && (
              <div className="pager">
                <button className="btn big" disabled={at === 0} onClick={() => setPage(at - 1)} aria-label="Newer matches"><Icon name="chevronLeft" /> Newer</button>
                <span>{at + 1} / {pages}</span>
                <button className="btn big" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} aria-label="Older matches">Older <Icon name="chevronRight" /></button>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Stat({ area, title, value, note }: { area: string; title: string; value: string; note: string }) {
  return (
    <section className="locker-card stat" style={{ gridArea: area }}>
      <div className="plate-head" style={{ fontSize: 19 }}>{title}</div>
      <div className="card-body">
        <span className="big-number">{value}</span>
        <span className="muted">{note}</span>
      </div>
    </section>
  );
}
