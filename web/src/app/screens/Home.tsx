import { useEffect, useState } from "react";
import { Bar } from "../ui/Bar";
import { Icon } from "../ui/Icon";
import { useNav } from "../store/nav";
import { useSettings } from "../store/settings";
import { all } from "../store/db";
import { useSchedule } from "../schedule/useSchedule";
import { fixture, ourTeam, upcoming, when, type Schedule } from "../schedule/schedule";
import { useUpdate } from "../updates";

interface MatchRow { id: string; createdAt: string; opponent: string; finished: boolean; score?: string; sets?: string; setsWon?: { home: number; opponent: number } }

/**
 * The Match section, where the app opens: the match in play or the next one, large, with the one big button; beside
 * it what is coming up (a tap sets that match up) and the latest results (a tap opens the match). Everything else is
 * one tap away in the tab bar.
 */
export function Home() {
  const teamName = useSettings((s) => s.teamName);
  const { schedule, refresh } = useSchedule();
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [standalone] = useState(() => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
  const [hideInstall, setHideInstall] = useState(() => { try { return localStorage.getItem("coachboard.installHint") === "hidden"; } catch { return false; } });
  const update = useUpdate();

  useEffect(() => {
    all<MatchRow>("matches").then((m) => setMatches(m.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))).catch(() => {});
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const unfinished = matches.find((m) => !m.finished);
  const coming = upcoming(schedule).filter((m) => !m.cancelled);
  // The hero shows the match in play, else the next scheduled one; the list shows the rest.
  const later = unfinished ? coming : coming.slice(1);

  return (
    <div className="screen">
      <Bar title={teamName || "Your team"} subtitle={<><span className="brand">Coach Board</span> · {today}</>}>
        {update.ready && <button className="btn primary small" onClick={update.apply}><Icon name="download" /> New version</button>}
      </Bar>

      {!standalone && !hideInstall && (
        <div className="install-strip">
          <Icon name="share" size={22} />
          <span style={{ flex: 1, minWidth: 0 }}><strong>Full screen and offline:</strong> in Safari tap Share, then “Add to Home Screen”. Do it before your first match: the home-screen app keeps its own data.</span>
          <button className="btn small" onClick={() => { setHideInstall(true); try { localStorage.setItem("coachboard.installHint", "hidden"); } catch { /* ignore */ } }}>
            Got it
          </button>
        </div>
      )}

      <main className="fill match-home">
        <GameDay unfinished={unfinished} schedule={schedule} />
        <ComingUp schedule={schedule} later={later} />
        <Results matches={matches.filter((m) => m.id !== unfinished?.id)} />
      </main>
    </div>
  );
}

/** The match in play, else the next one: the opponent, the score or the start time in big numbers, and the button. */
function GameDay({ unfinished, schedule }: { unfinished?: MatchRow; schedule?: Schedule }) {
  const go = useNav((s) => s.go);
  const team = schedule ? ourTeam(schedule) : undefined;
  const next = upcoming(schedule).filter((m) => !m.cancelled)[0];
  const f = next ? fixture(next, team) : undefined;

  return (
    <section className="locker-card gameday" style={{ gridArea: "hero" }}>
      <div className="plate-head">
        <span className="plate"><Icon name="whistle" size={20} /> {unfinished ? "Game on" : "Next match"}</span>
        {!unfinished && next && f?.home !== undefined && <span className={`badge ${f.home ? "home" : "away"}`}>{f.home ? "Home" : "Away"}</span>}
      </div>
      <div className="card-body">
        {unfinished ? (
          <>
            <div>
              <div className="gameday-vs live">Playing now</div>
              <h2 className="gameday-opponent" style={{ fontSize: fitSize(`vs ${unfinished.opponent}`) }}>vs {unfinished.opponent}</h2>
            </div>
            <div className="gameday-score" aria-label={`Sets ${unfinished.sets ?? "0–0"}, this set ${unfinished.score ?? "0–0"}`}>
              <div><span className="label">Sets</span><strong>{unfinished.sets ?? "0–0"}</strong></div>
              <div><span className="label">This set</span><strong>{unfinished.score ?? "0–0"}</strong></div>
            </div>
          </>
        ) : next ? (
          <>
            <div style={{ minWidth: 0 }}>
              <div className="gameday-vs">{when(next).split(" · ")[0]}</div>
              <h2 className="gameday-opponent" style={{ fontSize: fitSize(f?.opponent ? `vs ${f.opponent}` : next.title) }}>
                {f?.opponent ? `vs ${f.opponent}` : next.title}
              </h2>
              {next.venue && <div className="gameday-where">{next.venue}</div>}
            </div>
            <div className="gameday-score" aria-label={when(next)}>
              <div><span className="label">Start</span><strong>{when(next).split(" · ")[1]}</strong></div>
            </div>
          </>
        ) : (
          <div>
            <div className="gameday-vs">Ready when you are</div>
            <h2 className="gameday-opponent">Your next match</h2>
            <div className="gameday-where">Set up the lineup and keep score with one tap a point.</div>
          </div>
        )}

        <div className="stack" style={{ gap: 12 }}>
          {unfinished ? (
            <>
              <button className="btn primary wide" onClick={() => go({ name: "live", matchId: unfinished.id })}>
                <Icon name="play" /> Resume match
              </button>
              <button className="btn secondary big wide" onClick={() => go({ name: "setup" })}>New match</button>
            </>
          ) : (
            <button className="btn primary wide" onClick={() => go(next ? { name: "setup", scheduled: next.id } : { name: "setup" })}>
              <Icon name="play" /> Start match
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** The schedule after the hero's match: a tap sets that match up. Without a schedule, the way to link one. */
function ComingUp({ schedule, later }: { schedule?: Schedule; later: ReturnType<typeof upcoming> }) {
  const go = useNav((s) => s.go);
  const team = schedule ? ourTeam(schedule) : undefined;
  return (
    <section className="locker-card" style={{ gridArea: "coming" }}>
      <div className="plate-head">
        <span className="plate"><Icon name="calendar" size={20} /> Coming up</span>
        {schedule && <span className="aside">{later.length} planned</span>}
      </div>
      <div className="card-body">
        {!schedule ? (
          <div className="empty" style={{ flex: 1, padding: 12 }}>
            Link your club's schedule once and your matches fill in by themselves.
            <button className="btn big" onClick={() => go({ name: "settings", section: "schedule" })}><Icon name="calendar" /> Link schedule</button>
          </div>
        ) : later.length === 0 ? (
          <div className="empty" style={{ flex: 1, padding: 12 }}>Nothing else planned yet.</div>
        ) : (
          <div className="rows">
            {later.slice(0, 3).map((m) => {
              const x = fixture(m, team);
              return (
                <button key={m.id} className="upnext-row" onClick={() => go({ name: "setup", scheduled: m.id })}
                        aria-label={`${when(m)}, ${x.opponent ?? m.title}, set up this match`}>
                  <span className="when">{when(m).split(" · ")[0]}</span>
                  <span className="who">{x.opponent ? `vs ${x.opponent}` : m.title}</span>
                  {x.home !== undefined && <span className={`badge ${x.home ? "home" : "away"}`}>{x.home ? "Home" : "Away"}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** The latest matches with their result: a tap opens the match log (or the match, while it is being played). */
function Results({ matches }: { matches: MatchRow[] }) {
  const go = useNav((s) => s.go);
  return (
    <section className="locker-card" style={{ gridArea: "results" }}>
      <div className="plate-head">
        <span className="plate"><Icon name="trophy" size={20} /> Results</span>
        {matches.length > 0 && <button className="btn small quiet" style={{ marginLeft: "auto" }} onClick={() => go({ name: "season" })}>Season <Icon name="chevronRight" /></button>}
      </div>
      <div className="card-body">
        {matches.length === 0 ? (
          <div className="empty" style={{ flex: 1, padding: 12 }}>Your results show here after your first match.</div>
        ) : (
          <div className="rows">
            {matches.slice(0, 3).map((m) => {
              const won = m.setsWon ? m.setsWon.home > m.setsWon.opponent : undefined;
              return (
                <button key={m.id} className="match-row" onClick={() => go(m.finished ? { name: "log", matchId: m.id } : { name: "live", matchId: m.id })}>
                  <span className="date">{new Date(m.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                  <span className="who">vs {m.opponent}</span>
                  <span className="sets">{m.sets ?? "–"}</span>
                  <span className={`badge ${!m.finished ? "" : won ? "won" : "lost"}`}>{!m.finished ? "Playing" : won ? "Won" : "Lost"}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** Big for a short name, smaller for a long one, so the opponent fits in two lines. */
function fitSize(text: string): string {
  const n = text.length;
  return n <= 14 ? "clamp(34px, 4vw, 52px)" : n <= 22 ? "clamp(28px, 3.2vw, 42px)" : "clamp(24px, 2.6vw, 34px)";
}
