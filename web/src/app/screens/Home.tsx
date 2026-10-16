import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { useNav } from "../store/nav";
import { useSettings } from "../store/settings";
import { all } from "../store/db";

interface MatchRow { id: string; createdAt: string; opponent: string; finished: boolean; score?: string; sets?: string }

/** Start screen: one primary action, the tools as tiles, the latest matches. */
export function Home() {
  const go = useNav((s) => s.go);
  const advanced = useSettings((s) => s.advanced);
  const teamName = useSettings((s) => s.teamName);
  const [players, setPlayers] = useState(0);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [standalone] = useState(() => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
  const [hideInstall, setHideInstall] = useState(() => { try { return localStorage.getItem("coachboard.installHint") === "hidden"; } catch { return false; } });

  useEffect(() => {
    all<MatchRow>("matches").then((m) => setMatches(m.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))).catch(() => {});
    all("players").then((p) => setPlayers(p.length)).catch(() => {});
  }, []);

  const unfinished = matches.find((m) => !m.finished);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="screen">
      <div className="scroll">
        <div className="page stack" style={{ gap: 22 }}>
          <section className="hero stack" style={{ gap: 18 }}>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
                <div className="label">{today}</div>
                <h1 className="title">Coach Board</h1>
                <div className="row" style={{ gap: 12 }}>
                  <span className="nameplate">{teamName || "Your team"}</span>
                  <span className="stars" aria-hidden="true">★★★</span>
                </div>
              </div>
              <button className="btn secondary" onClick={() => go({ name: "settings" })}>
                <Icon name="settings" /> Settings
              </button>
            </div>
            <div className="row">
              {unfinished ? (
                <>
                  <button className="btn primary" onClick={() => go({ name: "live", matchId: unfinished.id })}>
                    <Icon name="play" /> Resume match
                  </button>
                  <span style={{ color: "var(--c-bandSoft)" }}>vs {unfinished.opponent}{unfinished.score ? ` · ${unfinished.score}` : ""}</span>
                </>
              ) : (
                <button className="btn primary" onClick={() => go({ name: "setup" })}>
                  <Icon name="play" /> Start match
                </button>
              )}
              {unfinished && <button className="btn secondary" onClick={() => go({ name: "setup" })}>New match</button>}
            </div>
          </section>

          {!standalone && !hideInstall && (
            <div className="card row" style={{ gap: 16 }}>
              <Icon name="share" size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>Put Coach Board on your Home Screen</strong>
                <div className="muted">In Safari, tap Share, then “Add to Home Screen”. It then opens full screen and works without internet.</div>
              </div>
              <button className="btn quiet small" onClick={() => { setHideInstall(true); try { localStorage.setItem("coachboard.installHint", "hidden"); } catch { /* ignore */ } }}>
                Got it
              </button>
            </div>
          )}

          <div className="grid-lockers">
            <Locker icon="cube" title="Studio" note="2D · 3D" text={advanced ? "Tactics in 2D and 3D, zones, the ball, eye views" : "Draw plays on a 2D or 3D court"} onClick={() => go({ name: "studio" })} />
            <Locker icon="video" title="Video to 3D" note="Eye view" text={advanced ? "Rebuild a rally from video; eye view of any player" : "Turn a rally video into 3D"} onClick={() => go({ name: "video" })} />
            <Locker icon="players" title="Players" note={players ? `${players} on the team` : ""} text="Add your players by number" onClick={() => go({ name: "players" })} />
            <Locker icon="season" title="Season" note={matches.length ? `${matches.length} matches` : ""} text="How your team did, match by match" onClick={() => go({ name: "season" })} />
          </div>

          {matches.length > 0 && (
            <section>
              <h2 className="group-title">Recent matches</h2>
              <div className="list">
                {matches.slice(0, 6).map((m) => (
                  <button key={m.id} className="btn quiet" style={{ justifyContent: "flex-start", borderRadius: 0 }}
                          onClick={() => go(m.finished ? { name: "log", matchId: m.id } : { name: "live", matchId: m.id })}>
                    <span style={{ flex: 1, textAlign: "left" }}>vs {m.opponent}</span>
                    <span className="mono muted">{m.sets ?? m.score ?? ""}</span>
                    <span className="muted">{new Date(m.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Locker({ icon, title, note, text, onClick }: { icon: string; title: string; note: string; text: string; onClick: () => void }) {
  return (
    <button className="locker" onClick={onClick}>
      <div className="plate">{title}<span className="num">{note}</span></div>
      <div className="inside">
        <Icon name={icon} className="tile-icon" size={34} />
        <span>{text}</span>
      </div>
      <div className="vent" aria-hidden="true" />
    </button>
  );
}
