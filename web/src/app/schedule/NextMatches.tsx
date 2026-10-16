import { useEffect, useState } from "react";
import { useNav } from "../store/nav";
import { fixture, ourTeam, upcoming, when, type ScheduledMatch } from "./schedule";
import { useSchedule } from "./useSchedule";
import { updatedAt } from "./ScheduleSettings";

const HINT_KEY = "coachboard.scheduleHint";

/** "vs Saasveldia HS 1", else the feed's own title. */
export function matchName(m: ScheduledMatch, team: string | undefined): string {
  const f = fixture(m, team);
  return f.opponent ? `vs ${f.opponent}` : m.title;
}

/** The next match in one line for the start screen's hero, or nothing when no schedule is linked. */
export function NextMatchLine() {
  const schedule = useSchedule((s) => s.schedule);
  const next = upcoming(schedule).find((m) => !m.cancelled);
  if (!schedule || !next) return null;
  const f = fixture(next, ourTeam(schedule));
  return (
    <div style={{ color: "var(--c-bandSoft)" }} data-testid="next-match">
      <span className="label" style={{ color: "var(--c-bandSoft)" }}>Next match</span>{" "}
      <strong style={{ color: "var(--c-bandText)" }}>{when(next)} · {matchName(next, ourTeam(schedule))}</strong>
      {f.home !== undefined && <span> · {f.home ? "home" : "away"}</span>}
    </div>
  );
}

/** Start screen: the next matches from the linked schedule (a tap starts that match), or an offer to link one. */
export function NextMatches() {
  const go = useNav((s) => s.go);
  const { schedule, loading, refresh } = useSchedule();
  const [hideHint, setHideHint] = useState(() => { try { return localStorage.getItem(HINT_KEY) === "hidden"; } catch { return false; } });

  useEffect(() => { void refresh(); }, [refresh]);

  if (!schedule) {
    if (hideHint) return null;
    return (
      <div className="card row" style={{ gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>Link your match schedule</strong>
          <div className="muted">Paste your team's programme link from the Nevobo once; your matches then show here.</div>
        </div>
        <button className="btn secondary small" onClick={() => go({ name: "settings" })}>Link schedule</button>
        <button className="btn quiet small" onClick={() => { setHideHint(true); try { localStorage.setItem(HINT_KEY, "hidden"); } catch { /* ignore */ } }}>
          Not now
        </button>
      </div>
    );
  }

  const team = ourTeam(schedule);
  const list = upcoming(schedule).slice(0, 4);
  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <h2 className="group-title" style={{ margin: 0 }}>Next matches</h2>
        <span className="muted" style={{ fontSize: 14 }}>{loading ? "Updating…" : `Updated ${updatedAt(schedule.fetchedAt)}`}</span>
      </div>
      {list.length === 0 ? (
        <div className="card muted">No more matches in the schedule.</div>
      ) : (
        <div className="list">
          {list.map((m) => {
            const f = fixture(m, team);
            return (
              <button key={m.id} className="btn quiet" disabled={m.cancelled}
                      style={{ justifyContent: "flex-start", borderRadius: 0, whiteSpace: "normal", textAlign: "left", fontWeight: 400, flexWrap: "wrap", rowGap: 2 }}
                      onClick={() => go({ name: "setup", scheduled: m.id })}
                      aria-label={`${when(m)}, ${matchName(m, team)}${m.cancelled ? ", cancelled" : ", start this match"}`}>
                <span className="mono" style={{ minWidth: 170, flex: "none", fontSize: 15, whiteSpace: "nowrap" }}>{when(m)}</span>
                <span style={{ flex: "1 1 200px", minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <strong style={{ fontWeight: 600, textDecoration: m.cancelled ? "line-through" : undefined }}>{matchName(m, team)}</strong>
                  {m.venue && <span className="muted" style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.venue}</span>}
                </span>
                {m.cancelled
                  ? <span className="label" style={{ color: "var(--c-fault)" }}>Cancelled</span>
                  : f.home !== undefined && <span className="label">{f.home ? "Home" : "Away"}</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
