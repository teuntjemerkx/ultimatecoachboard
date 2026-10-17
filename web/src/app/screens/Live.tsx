import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { Choice } from "../ui/Choice";
import { Court2D, type CourtToken } from "../ui/Court2D";
import { useNav } from "../store/nav";
import { usePortrait } from "../hooks/useViewport";
import { MatchSession, useMatch } from "../match/session";
import { CourtFrame, LiveEvent, RotationRecord, RotationStats, Scoring, type LoggedAction, type Side } from "../../core/match";
import { SubSheet } from "./SubSheet";

/** What the next undo takes back, in a few words under the Undo button. */
function undoText(session: MatchSession, last: LoggedAction | undefined): string {
  if (!last) return "Nothing yet";
  const a = last.action;
  const team = (side: Side) => (side === "home" ? session.state.setup.homeName ?? "Us" : session.state.setup.opponentName ?? "Them");
  switch (a.kind) {
    case "rally": return `Point ${team(a.winner)}`;
    case "timeOut": return `Time-out ${team(a.side)}`;
    case "substitution": return `${a.side === "home" ? "Sub" : "Their"} ${session.who(a.incoming)} for ${session.who(a.outgoing)}`;
    case "nextSet": return "Start of the set";
    default: return "Last entry";
  }
}

/** A time-out being taken: the logged action it belongs to, and when its time runs out (ms). */
interface RunningTimeOut { side: Side; seq: number; endsAt: number }

/** Screen 3: the court with both teams in their rotations, the score, and one tap for each point. */
export function Live({ matchId }: { matchId: string }) {
  const go = useNav((s) => s.go);
  const { session, version, open, dispatch } = useMatch();
  const portrait = usePortrait();
  const [flipped, setFlipped] = useState(false);
  const [missing, setMissing] = useState(false);
  const [subbing, setSubbing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null);
  const [clock, setClock] = useState<RunningTimeOut | null>(null);
  const [, setTick] = useState(0);
  const lastTap = useRef<Record<string, number>>({});

  useEffect(() => {
    if (session?.id === matchId) return;
    MatchSession.open(matchId).then((s) => (s ? open(s) : setMissing(true)), () => setMissing(true));
  }, [matchId, session?.id, open]);

  // Store everything the moment the app goes to the background: iOS may close it without warning.
  useEffect(() => {
    if (!session) return;
    const away = () => { if (document.visibilityState === "hidden") void session.flush(); };
    const leave = () => void session.flush();
    document.addEventListener("visibilitychange", away);
    window.addEventListener("pagehide", leave);
    return () => { document.removeEventListener("visibilitychange", away); window.removeEventListener("pagehide", leave); void session.flush(); };
  }, [session]);

  // The time-out clock: redraw every half second while one runs, and let it go when the time is up.
  useEffect(() => {
    if (!clock) return;
    const id = window.setInterval(() => {
      if (Date.now() >= clock.endsAt) setClock(null);
      else setTick((n) => n + 1);
    }, 500);
    return () => window.clearInterval(id);
  }, [clock]);

  // A confirmation over the court fades after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), 3500);
    return () => window.clearTimeout(id);
  }, [notice]);

  // One action per tap: a finger that bounces on the glass does not score (or take a time-out) twice.
  const once = (key: string, ms: number) => {
    const t = performance.now();
    if (t - (lastTap.current[key] ?? -Infinity) < ms) return false;
    lastTap.current[key] = t;
    return true;
  };
  const point = (side: Side) => { if (once("point", 250)) dispatch(LiveEvent.pointSwipe(side)); };
  const callTimeOut = (side: Side) => {
    if (!once(`timeOut${side}`, 600) || !session) return;
    dispatch(LiveEvent.timeOut(side));
    const last = session.state.lastAction;
    if (last?.action.kind === "timeOut" && last.action.side === side) {
      setClock({ side, seq: last.seq, endsAt: Date.now() + session.state.profile.timeOuts.seconds * 1000 });
    }
  };

  if (missing) return <div className="screen"><div className="empty" style={{ flex: 1 }}>This match could not be opened.<button className="btn big" onClick={() => go({ name: "home" })}>Home</button></div></div>;
  if (!session || session.id !== matchId) return <div className="screen"><div className="empty" style={{ flex: 1 }}>Opening the match…<button className="btn big" onClick={() => go({ name: "home" })}>Home</button></div></div>;

  const st = session.state;
  const m = st.match;
  const set = m.current;
  const home = st.setup.homeName ?? "Us", away = st.setup.opponentName ?? "Opponent";
  const liberoIn = m.liberoIn("home");
  const tokens: CourtToken[] = st.tokens().map((t) => {
    const w = CourtFrame.world(t.point, t.side);
    const note = t.isLibero && t.side === "home" && liberoIn ? `for ${session.label(liberoIn.replaces, "")}` : undefined;
    return { id: `${t.side}${t.position}`, side: t.side, x: w.x, z: w.z, label: session.label(t.player, t.role),
             isLibero: t.isLibero, isServer: t.isServer, note };
  });
  const serverToken = st.tokens().find((t) => t.isServer);
  const serveText = set.serving === "home" ? `Our serve${serverToken ? ` · #${session.label(serverToken.player, "")}` : ""}` : "Their serve";
  const status = (["home", "opponent"] as Side[]).map((s) => ({ s, p: m.pointStatus(s) })).find((x) => x.p);
  const setOver = set.winner !== undefined;
  const last = st.lastAction;
  // The running time-out shows while its time lasts and it has not been undone.
  const running = clock && st.log.some((e) => e.seq === clock.seq && e.active) ? clock : null;
  const secondsLeft = running ? Math.max(0, Math.ceil((running.endsAt - Date.now()) / 1000)) : 0;
  const teamName = (side: Side) => (side === "home" ? home : away);

  return (
    <div className="screen" data-version={version}>
      <header className="bar scoreboard">
        <button className="btn home-btn" onClick={() => go({ name: "home" })} aria-label="Home"><Icon name="back" /></button>
        <span className="nameplate" style={{ fontSize: 17 }}>Set {set.number}</span>
        <div className="row" style={{ gap: 16, flex: 1, justifyContent: "center", flexWrap: "nowrap", minWidth: 0 }}>
          <span className="team" style={{ color: "var(--c-bandText)" }}>{home}</span>
          <span className="digits" aria-label={`${home} ${set.score.home}, ${away} ${set.score.opponent}`}>
            {set.score.home}<span style={{ opacity: 0.45, margin: "0 8px" }}>:</span>{set.score.opponent}
          </span>
          <span className="team" style={{ color: "var(--c-bandText)" }}>{away}</span>
        </div>
        <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
          <span className="athletic" style={{ color: "var(--c-bandText)", fontSize: 18, whiteSpace: "nowrap" }}>{serveText}</span>
          <span className="athletic" style={{ color: "var(--c-bandSoft)", fontSize: 16, whiteSpace: "nowrap" }}>Rotation {m.rotationNumber("home")}</span>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: portrait ? "column" : "row" }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
          <Court2D tokens={tokens} vertical={portrait} flipped={flipped} />
          <div className="court-pills">
            {session.unsaved && (
              <button className="hint-pill unsaved-pill" onClick={() => void session.save()}>
                Not saved on this iPad yet · tap to try again
              </button>
            )}
            {running && (
              <button className="hint-pill timeout-pill" style={{ ["--team" as string]: running.side === "home" ? "var(--c-home)" : "var(--c-opponent)" }}
                      onClick={() => setClock(null)} aria-label={`Time-out ${teamName(running.side)}, ${secondsLeft} seconds left. Tap to close.`}>
                <span className="pip on" aria-hidden="true" />
                <span>Time-out {teamName(running.side)}</span>
                <span className="clock">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</span>
                <Icon name="close" size={20} />
              </button>
            )}
            {status && !session.unsaved && (
              <div className="hint-pill" style={{ color: "var(--c-text)", fontWeight: 800, fontSize: 20 }}>
                {status.p === "matchPoint" ? "Match point" : "Set point"} for {status.s === "home" ? home : away}
              </div>
            )}
            {notice && <div className="hint-pill" role="status" style={{ color: "var(--c-text)", fontWeight: 700, fontSize: 18 }}>{notice.text}</div>}
          </div>
        </div>
        <aside className={`live-aside ${portrait ? "portrait" : "landscape"}`}>
          <button className="point-btn" disabled={setOver} onClick={() => point("home")} style={{ ["--team" as string]: "var(--c-home)", ["--on-team" as string]: "var(--c-onHome)" }}>
            Point
            <small>{home}</small>
          </button>
          <button className="point-btn" disabled={setOver} onClick={() => point("opponent")} style={{ ["--team" as string]: "var(--c-opponent)", ["--on-team" as string]: "var(--c-onOpponent)" }}>
            Point
            <small>{away}</small>
          </button>
          {(["home", "opponent"] as Side[]).map((side) => {
            const left = m.timeOutsLeft(side);
            return (
              <button key={side} className="btn live-btn timeout-btn" disabled={setOver || left === 0} onClick={() => callTimeOut(side)}
                      style={{ ["--team" as string]: side === "home" ? "var(--c-home)" : "var(--c-opponent)" }}
                      aria-label={`Time-out ${teamName(side)}, ${left} of ${m.maxTimeOutsPerSet} left in this set`}>
                <span className="live-btn-title"><Icon name="timeout" /> Time-out</span>
                <small className="with-pips">
                  <span className="pips" aria-hidden="true">
                    {Array.from({ length: m.maxTimeOutsPerSet }, (_, i) => <span key={i} className={`pip${i < left ? " on" : ""}`} />)}
                  </span>
                  <span className="who">{teamName(side)}</span>
                </small>
              </button>
            );
          })}
          <button className="btn live-btn" disabled={setOver} onClick={() => setSubbing(true)}
                  aria-label={`Substitution, ${m.substitutionsLeft("home")} of ${m.maxSubstitutionsPerSet} left in this set for ${home}, ${m.substitutionsLeft("opponent")} for ${away}`}>
            <span className="live-btn-title"><Icon name="sub" /> Sub</span>
            <small>Us {m.substitutionsLeft("home")} · Them {m.substitutionsLeft("opponent")} left</small>
          </button>
          <button className="btn live-btn" onClick={() => dispatch(LiveEvent.undo)} disabled={!last}
                  aria-label={last ? `Undo ${undoText(session, last)}` : "Undo"}>
            <span className="live-btn-title"><Icon name="undo" /> Undo</span>
            <small>{undoText(session, last)}</small>
          </button>
          <button className="btn live-btn" onClick={() => setFlipped((f) => !f)}>
            <span className="live-btn-title"><Icon name="swap" /> Swap</span>
            <small>Sides on screen</small>
          </button>
          <button className="btn live-btn secondary" onClick={() => go({ name: "log", matchId })}>
            <span className="live-btn-title"><Icon name="film" /> Log</span>
            <small>Every rally</small>
          </button>
        </aside>
      </div>

      {subbing && !setOver && (
        <SubSheet session={session} onClose={() => setSubbing(false)}
                  onDone={(text) => { setSubbing(false); setNotice({ text, id: Date.now() }); }} />
      )}
      {setOver && <SetBreak session={session} onDone={() => go({ name: "home" })} onLog={() => go({ name: "log", matchId })} />}
    </div>
  );
}

/** Screen 6: the set's result, side-out by rotation, and the start of the next set. */
function SetBreak({ session, onDone, onLog }: { session: MatchSession; onDone: () => void; onLog: () => void }) {
  const dispatch = useMatch((s) => s.dispatch);
  const st = session.state, m = st.match, set = m.current;
  const won = set.winner === "home";
  const records = RotationStats.records(st.rallies, "home", set.number);
  const suggested = RotationStats.suggestedStart(RotationStats.records(st.rallies, "home"));
  const [firstServer, setFirstServer] = useState<Side>(set.firstServer === "home" ? "opponent" : "home");
  const [start, setStart] = useState<number>(suggested?.rotation ?? 1);
  const decidingSet = set.number + 1 === Scoring.decidingSetNumber(m.scoring);

  return (
    <div className="sheet">
      <div className="card stack" style={{ gap: 20 }}>
        <div>
          <div className="label">{m.isOver ? "Match over" : `Set ${set.number} done`}</div>
          <h2 className="title" style={{ fontSize: 40 }}>
            {m.isOver ? (m.setsWon("home") > m.setsWon("opponent") ? "Match won" : "Match lost") : won ? "Set won" : "Set lost"}{" "}
            <span className="mono">{m.isOver ? `${m.setsWon("home")}–${m.setsWon("opponent")}` : `${set.score.home}–${set.score.opponent}`}</span>
          </h2>
        </div>
        <section>
          <h3 className="group-title">Side-out by rotation</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, alignItems: "end", height: 150 }}>
            {[1, 2, 3, 4, 5, 6].map((r) => {
              const rec = records.find((x) => x.rotation === r);
              const rate = rec ? RotationRecord.sideOutRate(rec) : undefined;
              return (
                <div key={r} className="stack" style={{ gap: 6, alignItems: "center", height: "100%", justifyContent: "flex-end" }}>
                  <span className="mono" style={{ fontSize: 14 }}>{rec ? `${rec.receiveWon}/${RotationRecord.receiveTotal(rec)}` : "–"}</span>
                  <div className="bar-fill" style={{ height: `${Math.max(4, (rate ?? 0) * 100)}%`, opacity: rate === undefined ? 0.25 : 1 }} />
                  <span className="athletic" style={{ fontSize: 18 }}>{r}</span>
                </div>
              );
            })}
          </div>
          <p className="muted" style={{ margin: "8px 0 0" }}>Points won on their serve, per rotation.</p>
        </section>
        {m.isOver ? (
          <div className="row">
            <button className="btn primary" onClick={onDone}>Done</button>
            <button className="btn big secondary" onClick={onLog}>Match log</button>
            <button className="btn big secondary" onClick={() => dispatch(LiveEvent.undo)}><Icon name="undo" /> Undo last point</button>
          </div>
        ) : (
          <>
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Start the next set in rotation</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
                {[1, 2, 3, 4, 5, 6].map((r) => (
                  <button key={r} className={`btn big ${start === r ? "on" : ""}`} style={{ font: "800 26px/1 var(--font-athletic)" }} onClick={() => setStart(r)}>{r}</button>
                ))}
              </div>
              {suggested && <span className="muted">Suggested: rotation {suggested.rotation} (best side-out so far).</span>}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Who serves first?{decidingSet ? " (deciding set: use the coin toss)" : ""}</span>
              <Choice label="Who serves first" value={firstServer} onChange={setFirstServer}
                      options={[{ value: "home", title: st.setup.homeName ?? "Us" }, { value: "opponent", title: st.setup.opponentName ?? "Them" }]} />
            </div>
            <div className="row">
              <button className="btn primary" onClick={() => dispatch(LiveEvent.startNextSet(firstServer, start))}>
                <Icon name="play" /> Start set {set.number + 1}
              </button>
              <button className="btn big secondary" onClick={() => dispatch(LiveEvent.undo)}><Icon name="undo" /> Undo last point</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
