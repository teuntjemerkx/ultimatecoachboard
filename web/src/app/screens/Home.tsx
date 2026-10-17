import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { useNav } from "../store/nav";
import { useSettings } from "../store/settings";
import { all } from "../store/db";
import { useSchedule } from "../schedule/useSchedule";
import { fixture, ourTeam, upcoming, when } from "../schedule/schedule";
import { PrizmCard } from "../ui/PrizmCard";
import { roleChip, type Player } from "./Players";
import { useUpdate } from "../updates";

interface MatchRow { id: string; createdAt: string; opponent: string; finished: boolean; score?: string; sets?: string; setsWon?: { home: number; opponent: number } }

/**
 * Start screen: the locker room, filling the screen. Game day on the left (the next match and the one gold button),
 * the four tools as lockers beside it. Nothing to scroll or swipe.
 */
export function Home() {
  const go = useNav((s) => s.go);
  const advanced = useSettings((s) => s.advanced);
  const teamName = useSettings((s) => s.teamName);
  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [standalone] = useState(() => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
  const [hideInstall, setHideInstall] = useState(() => { try { return localStorage.getItem("coachboard.installHint") === "hidden"; } catch { return false; } });

  useEffect(() => {
    all<MatchRow>("matches").then((m) => setMatches(m.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))).catch(() => {});
    all<Player>("players").then((p) => setPlayers(p.sort((a, b) => a.number - b.number))).catch(() => {});
  }, []);

  const update = useUpdate();
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const last = matches.find((m) => m.finished);
  const lastResult = last?.setsWon ? `${last.setsWon.home > last.setsWon.opponent ? "Won" : "Lost"} ${last.setsWon.home}–${last.setsWon.opponent}` : undefined;

  return (
    <div className="screen">
      <header className="home-head">
        <div className="home-brand">
          <div className="home-sub">
            <span className="nameplate">Coach Board</span>
            <span className="label">{today}</span>
          </div>
          <h1 className="home-team">{teamName || "Your team"}</h1>
        </div>
        <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
          {update.ready && (
            <button className="btn primary" onClick={update.apply}><Icon name="download" /> New version · restart</button>
          )}
          <button className="btn secondary settings-btn" onClick={() => go({ name: "settings" })}>
            <Icon name="settings" size={24} /> Settings
          </button>
        </div>
      </header>

      {!standalone && !hideInstall && (
        <div className="install-strip">
          <Icon name="share" size={24} />
          <span style={{ flex: 1, minWidth: 0 }}><strong>Full screen and offline:</strong> in Safari tap Share, then “Add to Home Screen”. Do it before your first match: the home-screen app keeps its own data.</span>
          <button className="btn small" onClick={() => { setHideInstall(true); try { localStorage.setItem("coachboard.installHint", "hidden"); } catch { /* ignore */ } }}>
            Got it
          </button>
        </div>
      )}

      <main className="fill home-grid">
        <GameDay matches={matches} />
        <Locker area="studio" num="01" icon="cube" title="Studio" note="2D · 3D"
                text={advanced ? "Tactics in 2D and 3D, zones, the ball, eye views" : "Draw plays on a 2D or 3D court"}
                onClick={() => go({ name: "studio" })} />
        <Locker area="video" num="02" icon="video" title="Video to 3D" note="Eye view"
                text={advanced ? "Rebuild a rally from video; see it through any player's eyes" : "Turn a rally video into 3D"}
                onClick={() => go({ name: "video" })} />
        <Locker area="players" num="03" icon="shirt" title="Players" note={players.length ? `${players.length} on the team` : undefined}
                text="Your team as trading cards" onClick={() => go({ name: "players" })}>
          {players.length > 0 && (
            <div className="locker-fan" aria-hidden="true">
              {players.slice(0, 3).map((p, k) => (
                <div key={p.id} style={{ transform: `rotate(${(k - 1) * 9}deg) translateY(${Math.abs(k - 1) * 6}px)`, zIndex: k === 1 ? 2 : 1 }}>
                  <PrizmCard number={p.number} name={p.name} role={roleChip(p.role)} />
                </div>
              ))}
            </div>
          )}
        </Locker>
        <Locker area="season" num="04" icon="trophy" title="Season" note={lastResult ?? (matches.length ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : undefined)}
                text="How your team did, match by match" onClick={() => go({ name: "season" })} />
      </main>
    </div>
  );
}

/** Game day: a match in progress to resume, else the next match from the schedule, and the one gold button. */
function GameDay({ matches }: { matches: MatchRow[] }) {
  const go = useNav((s) => s.go);
  const { schedule, refresh } = useSchedule();
  useEffect(() => { void refresh(); }, [refresh]);
  const unfinished = matches.find((m) => !m.finished);
  const team = schedule ? ourTeam(schedule) : undefined;
  const coming = upcoming(schedule).filter((m) => !m.cancelled);
  const next = coming[0];
  const f = next ? fixture(next, team) : undefined;

  return (
    <section className="locker-card gameday" style={{ gridArea: "game" }}>
      <div className="plate-head">
        <span className="plate"><Icon name="whistle" size={20} /> {unfinished ? "Game on" : "Game day"}</span>
        {!unfinished && next && f?.home !== undefined && <span className={`badge ${f.home ? "home" : "away"}`}>{f.home ? "Home" : "Away"}</span>}
      </div>
      <div className="card-body">
        {unfinished ? (
          <div>
            <div className="gameday-vs">Playing now</div>
            <h2 className="gameday-opponent" style={{ fontSize: fitSize(`vs ${unfinished.opponent}`) }}>vs {unfinished.opponent}</h2>
            {unfinished.score && <div className="gameday-when">{unfinished.sets && unfinished.sets !== "0–0" ? `Sets ${unfinished.sets} · ` : ""}this set {unfinished.score}</div>}
          </div>
        ) : next ? (
          <div style={{ minWidth: 0 }}>
            <div className="gameday-vs">Next match</div>
            <h2 className="gameday-opponent" style={{ fontSize: fitSize(f?.opponent ? `vs ${f.opponent}` : next.title) }}>
              {f?.opponent ? `vs ${f.opponent}` : next.title}
            </h2>
            <div className="gameday-when">{when(next)}</div>
            {next.venue && <div className="gameday-where">{next.venue}</div>}
          </div>
        ) : (
          <div>
            <div className="gameday-vs">Ready when you are</div>
            <h2 className="gameday-opponent">Your next match</h2>
            <div className="gameday-where">Link your schedule once and your matches show here.</div>
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
          {!unfinished && coming.length > 1 && (
            <div className="upnext">
              <span className="label">Up next</span>
              {coming.slice(1, 3).map((m) => {
                const x = fixture(m, team);
                return (
                  <button key={m.id} className="upnext-row" onClick={() => go({ name: "setup", scheduled: m.id })}
                          aria-label={`${when(m)}, ${x.opponent ?? m.title}, start this match`}>
                    <span className="when">{when(m).split(" · ")[0]}</span>
                    <span className="who">{x.opponent ? `vs ${x.opponent}` : m.title}</span>
                    {x.home !== undefined && <span className={`badge ${x.home ? "home" : "away"}`}>{x.home ? "Home" : "Away"}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {!schedule && (
            <button className="btn secondary big wide" onClick={() => go({ name: "settings", section: "schedule" })}>
              <Icon name="calendar" /> Link schedule
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Big for a short name, smaller for a long one, so the opponent fits in two lines. */
function fitSize(text: string): string {
  const n = text.length;
  return n <= 14 ? "clamp(40px, 5vw, 64px)" : n <= 22 ? "clamp(34px, 3.9vw, 52px)" : "clamp(28px, 3.1vw, 42px)";
}

function Locker({ area, num, icon, title, note, text, onClick, children }: {
  area: string; num: string; icon: string; title: string; note?: string; text: string; onClick: () => void; children?: React.ReactNode;
}) {
  return (
    <button className="locker-btn" style={{ gridArea: area }} onClick={onClick}>
      <span className="num" aria-hidden="true">{num}</span>
      {children}
      {note && <span className="locker-note">{note}</span>}
      <div className="locker-body">
        <Icon name={icon} className="locker-icon" size={58} />
        <span className="locker-title">{title}</span>
        <span className="locker-text">{text}</span>
      </div>
    </button>
  );
}
