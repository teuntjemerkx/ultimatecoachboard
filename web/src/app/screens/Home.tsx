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
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [standalone] = useState(() => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
  const [hideInstall, setHideInstall] = useState(() => { try { return localStorage.getItem("coachboard.installHint") === "hidden"; } catch { return false; } });

  useEffect(() => {
    all<MatchRow>("matches").then((m) => setMatches(m.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))).catch(() => {});
  }, []);

  const unfinished = matches.find((m) => !m.finished);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="screen">
      <div className="scroll">
        <div className="page stack" style={{ gap: 24 }}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="label">{today}</div>
              <h1 className="title">Coach Board</h1>
            </div>
            <button className="btn secondary" onClick={() => go({ name: "settings" })}>
              <Icon name="settings" /> Settings
            </button>
          </div>

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

          <section className="card stack" style={{ gap: 12 }}>
            {unfinished ? (
              <>
                <div className="label">Match in progress</div>
                <div className="group-title" style={{ fontSize: 22, margin: 0 }}>vs {unfinished.opponent} {unfinished.score ? `· ${unfinished.score}` : ""}</div>
                <div className="row">
                  <button className="btn primary" onClick={() => go({ name: "live", matchId: unfinished.id })}>
                    <Icon name="play" /> Resume match
                  </button>
                  <button className="btn secondary" onClick={() => go({ name: "setup" })}>New match</button>
                </div>
              </>
            ) : (
              <>
                <div className="label">Ready to play</div>
                <div className="group-title" style={{ fontSize: 22, margin: 0 }}>Start a match and keep score</div>
                <div className="row">
                  <button className="btn primary" onClick={() => go({ name: "setup" })}>
                    <Icon name="play" /> Start match
                  </button>
                </div>
              </>
            )}
          </section>

          <div className="grid-tiles">
            <Tile icon="cube" title="Studio" text={advanced ? "Tactics in 2D and 3D, zones, the ball, eye views" : "Draw plays on a 2D or 3D court"} onClick={() => go({ name: "studio" })} />
            <Tile icon="video" title="Video to 3D" text={advanced ? "Rebuild a rally from video; eye view of any player" : "Turn a rally video into 3D"} onClick={() => go({ name: "video" })} />
            <Tile icon="players" title="Players" text="Add your players by number" onClick={() => go({ name: "players" })} />
            <Tile icon="season" title="Season" text="How your team did, match by match" onClick={() => go({ name: "season" })} />
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

function Tile({ icon, title, text, onClick }: { icon: string; title: string; text: string; onClick: () => void }) {
  return (
    <button className="tile" onClick={onClick}>
      <Icon name={icon} className="tile-icon" size={34} />
      <strong>{title}</strong>
      <span>{text}</span>
    </button>
  );
}
