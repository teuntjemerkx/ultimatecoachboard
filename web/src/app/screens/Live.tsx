import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (session?.id === matchId) return;
    MatchSession.open(matchId).then((s) => (s ? open(s) : setMissing(true)));
  }, [matchId, session?.id, open]);

  if (missing) return <div className="screen"><div className="empty">This match could not be opened.<button className="btn secondary" onClick={() => go({ name: "home" })}>Home</button></div></div>;
  if (!session || session.id !== matchId) return <div className="screen"><div className="empty">Opening the match…</div></div>;

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
      <header className="bar" style={{ gap: 16 }}>
        <button className="btn quiet" onClick={() => go({ name: "home" })} aria-label="Home"><Icon name="back" /></button>
        <span className="athletic" style={{ fontSize: 18, color: "var(--c-bandSoft)" }}>Set {set.number}</span>
        <div className="row" style={{ gap: 12, flex: 1, justifyContent: "center", flexWrap: "nowrap", minWidth: 0 }}>
          <span className="athletic" style={{ fontSize: 22, color: "var(--c-bandText)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{home}</span>
          <span className="mono" style={{ font: "800 40px/1 var(--font-athletic)", fontVariantNumeric: "tabular-nums" }}>
            {set.score.home}<span style={{ opacity: 0.5, margin: "0 6px" }}>:</span>{set.score.opponent}
          </span>
          <span className="athletic" style={{ fontSize: 22, color: "var(--c-bandText)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{away}</span>
        </div>
        <span style={{ color: "var(--c-bandSoft)", whiteSpace: "nowrap" }}>{serveText}</span>
        <span className="nameplate" style={{ fontSize: 15, padding: "5px 10px" }}>Rotation {m.rotationNumber("home")}</span>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: portrait ? "column" : "row" }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
          <Court2D tokens={tokens} vertical={portrait} flipped={flipped} />
          {status && (
            <div className="hint-pill" style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", color: "var(--c-text)", fontWeight: 700 }}>
              {status.p === "matchPoint" ? "Match point" : "Set point"} for {status.s === "home" ? home : away}
            </div>
          )}
        </div>
        <aside style={{
          display: "flex", flexDirection: portrait ? "row" : "column", gap: 12, padding: 16, width: portrait ? "auto" : 300,
          background: "var(--c-surface)", borderLeft: portrait ? 0 : "1px solid var(--c-hairline)", borderTop: portrait ? "1px solid var(--c-hairline)" : 0,
          paddingBottom: `calc(16px + env(safe-area-inset-bottom, 0px))`,
        }}>
          <button className="btn" disabled={setOver} onClick={() => dispatch(LiveEvent.pointSwipe("home"))}
                  style={{ flex: 1, minHeight: 120, background: "var(--c-home)", color: "#fff", font: "800 30px/1 var(--font-athletic)", textTransform: "uppercase", letterSpacing: "0.05em", flexDirection: "column", gap: 6 }}>
            Point
            <span style={{ fontSize: 20, opacity: 0.9 }}>{home}</span>
          </button>
          <button className="btn" disabled={setOver} onClick={() => dispatch(LiveEvent.pointSwipe("opponent"))}
                  style={{ flex: 1, minHeight: 120, background: "var(--c-opponent)", color: "#fff", font: "800 30px/1 var(--font-athletic)", textTransform: "uppercase", letterSpacing: "0.05em", flexDirection: "column", gap: 6 }}>
            Point
            <span style={{ fontSize: 20, opacity: 0.9 }}>{away}</span>
          </button>
          <div style={{ display: "flex", flexDirection: portrait ? "column" : "row", gap: 8 }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={() => dispatch(LiveEvent.undo)} disabled={st.log.length === 0}>
              <Icon name="undo" /> Undo
            </button>
            <button className="btn secondary" style={{ flex: 1 }} onClick={() => setFlipped((f) => !f)}>
              <Icon name="swap" /> Swap sides
            </button>
          </div>
          <button className="btn quiet" onClick={() => go({ name: "log", matchId })}>Match log</button>
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
    <div style={{ position: "fixed", inset: 0, background: "color-mix(in srgb, var(--c-bg) 82%, transparent)", display: "grid", placeItems: "center", padding: 16, zIndex: 20 }}>
      <div className="card stack" style={{ width: "min(720px, 100%)", gap: 18, maxHeight: "100%", overflowY: "auto" }}>
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
                  <div style={{ width: "100%", height: `${Math.max(4, (rate ?? 0) * 100)}%`, background: "var(--c-home)", borderRadius: 4, opacity: rate === undefined ? 0.2 : 1 }} />
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
            <button className="btn secondary" onClick={onLog}>Match log</button>
          </div>
        ) : (
          <>
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Start the next set in rotation</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
                {[1, 2, 3, 4, 5, 6].map((r) => (
                  <button key={r} className={`btn ${start === r ? "on" : "secondary"}`} onClick={() => setStart(r)}>{r}</button>
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
              <button className="btn quiet" onClick={() => dispatch(LiveEvent.undo)}><Icon name="undo" /> Undo last point</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
