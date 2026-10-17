import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { Choice } from "../ui/Choice";
import { Court2D, type CourtToken } from "../ui/Court2D";
import { useNav } from "../store/nav";
import { usePortrait } from "../hooks/useViewport";
import { MatchSession, useMatch } from "../match/session";
import { CourtFrame, LiveEvent, RotationRecord, RotationStats, Scoring, type Side } from "../../core/match";

/** Screen 3: the court with both teams in their rotations, the score, and one tap for each point. */
export function Live({ matchId }: { matchId: string }) {
  const go = useNav((s) => s.go);
  const { session, version, open, dispatch } = useMatch();
  const portrait = usePortrait();
  const [flipped, setFlipped] = useState(false);
  const [missing, setMissing] = useState(false);
  const lastPoint = useRef(0);

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

  // One point per tap: a finger that bounces on the glass does not score twice.
  const point = (side: Side) => {
    const t = performance.now();
    if (t - lastPoint.current < 250) return;
    lastPoint.current = t;
    dispatch(LiveEvent.pointSwipe(side));
  };

  if (missing) return <div className="screen"><div className="empty" style={{ flex: 1 }}>This match could not be opened.<button className="btn big" onClick={() => go({ name: "home" })}>Home</button></div></div>;
  if (!session || session.id !== matchId) return <div className="screen"><div className="empty" style={{ flex: 1 }}>Opening the match…<button className="btn big" onClick={() => go({ name: "home" })}>Home</button></div></div>;

  const st = session.state;
  const m = st.match;
  const set = m.current;
  const home = st.setup.homeName ?? "Us", away = st.setup.opponentName ?? "Opponent";
  const tokens: CourtToken[] = st.tokens().map((t) => {
    const w = CourtFrame.world(t.point, t.side);
    return { id: `${t.side}${t.position}`, side: t.side, x: w.x, z: w.z, label: session.label(t.player, t.role),
             isLibero: t.isLibero, isServer: t.isServer };
  });
  const serverToken = st.tokens().find((t) => t.isServer);
  const serveText = set.serving === "home" ? `Our serve${serverToken ? ` · #${session.label(serverToken.player, "")}` : ""}` : "Their serve";
  const status = (["home", "opponent"] as Side[]).map((s) => ({ s, p: m.pointStatus(s) })).find((x) => x.p);
  const setOver = set.winner !== undefined;

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
          {session.unsaved && (
            <button className="hint-pill unsaved-pill" onClick={() => void session.save()}>
              Not saved on this iPad yet · tap to try again
            </button>
          )}
          {status && !session.unsaved && (
            <div className="hint-pill" style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", color: "var(--c-text)", fontWeight: 800, fontSize: 20 }}>
              {status.p === "matchPoint" ? "Match point" : "Set point"} for {status.s === "home" ? home : away}
            </div>
          )}
        </div>
        <aside style={{
          display: "flex", flexDirection: portrait ? "row" : "column", gap: 14, padding: 18, width: portrait ? "auto" : 330,
          background: "linear-gradient(180deg, var(--c-surface), color-mix(in srgb, var(--c-surface) 80%, var(--c-bg)))",
          borderLeft: portrait ? 0 : "1px solid var(--c-hairline)", borderTop: portrait ? "1px solid var(--c-hairline)" : 0,
          paddingBottom: `calc(18px + env(safe-area-inset-bottom, 0px))`,
        }}>
          <button className="point-btn" disabled={setOver} onClick={() => point("home")} style={{ ["--team" as string]: "var(--c-home)", ["--on-team" as string]: "var(--c-onHome)" }}>
            Point
            <small>{home}</small>
          </button>
          <button className="point-btn" disabled={setOver} onClick={() => point("opponent")} style={{ ["--team" as string]: "var(--c-opponent)", ["--on-team" as string]: "var(--c-onOpponent)" }}>
            Point
            <small>{away}</small>
          </button>
          <div style={{ display: "flex", flexDirection: portrait ? "column" : "row", gap: 10 }}>
            <button className="btn big" style={{ flex: 1 }} onClick={() => dispatch(LiveEvent.undo)} disabled={st.log.length === 0}>
              <Icon name="undo" /> Undo
            </button>
            <button className="btn big" style={{ flex: 1 }} onClick={() => setFlipped((f) => !f)}>
              <Icon name="swap" /> Swap
            </button>
          </div>
          <button className="btn big secondary" onClick={() => go({ name: "log", matchId })}><Icon name="film" /> Match log</button>
        </aside>
      </div>

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
