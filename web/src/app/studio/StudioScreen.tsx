import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import "./studio.css";
import type { Side } from "../../core/match/court";
import { TeamSystem } from "../../core/match/teamSystem";
import { PlayerBodies, Posture } from "../../core/spatial";
import {
  AttackOption, ContactKind, SceneSetup, templateRotations, type RallyPhase, type ShapeKind, type ZonePattern, type ZoneTag,
} from "../../core/zones";
import { loadTemplate } from "../../core/zones/templateAccess";
import type { Board3D } from "../three/Board3D";
import { Bar } from "../ui/Bar";
import { Choice } from "../ui/Choice";
import { Icon } from "../ui/Icon";
import { useNav } from "../store/nav";
import { netHeight, useSettings } from "../store/settings";
import { Board2D } from "./Board2D";
import { StudioBoard3D, sightLines, studioOrbit } from "./StudioBoard3D";
import { deleteBoard, listBoards, studioBodies, useStudio, type BoardRecord, type StudioTool } from "./studio";

/** Plain names on the timeline: the receive marker is the pass. */
const phaseName: Record<RallyPhase, string> = {
  serve: "Serve", receive: "Pass", set: "Set", attack: "Attack", cover: "Cover", defence: "Defence",
};

/** Short names for the lineup menu. */
const systemShortName: Record<TeamSystem, string> = {
  "5-1-outside-follows-setter": "5-1", "5-1-middle-follows-setter": "5-1 (middle)", "6-2": "6-2", "4-2": "4-2", "youth-w": "Youth W",
};

/** Contact names on the ball strip. */
const contactName: Record<ContactKind, string> = {
  floatServe: "Float serve", jumpServe: "Jump serve", pass: "Pass", quickSet: "Quick set", secondTempoSet: "Second tempo",
  highSet: "High set", attack: "Attack", freeball: "Free ball", dig: "Dig",
};

/** Postures on the body strip, in rally order (Section 5.2's library). */
const postureOrder: Posture[] = [
  "standing", "readyHigh", "ready", "lowDefence", "pass", "angledPass", "overheadPass", "dig", "sprawl", "set", "backSet", "jumpSet",
  "approach", "armCock", "attack", "quickAttack", "landing", "blockReady", "block", "blockLanding", "floatServe", "jumpServe", "cover",
  "reach",
];

/** "LOW DEFENCE" reads "Low defence". */
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** What a name sheet edits: the board's title or a player's name or shirt number. */
interface Naming { heading: string; label: string; value: string; save: (v: string) => void }

function rotationsOf(system: string): number[] {
  const t = loadTemplate(system);
  return t ? templateRotations(t) : [1];
}

/** The width and height of an element, kept up to date (a callback ref: the element may mount after the screen). */
function useBoxSize<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size] as const;
}

/** A Studio control that reads as a button at arm's length: 44 point target, bold label. */
function Chip({ on, prominent, icon, onClick, children, label, disabled }: {
  on?: boolean; prominent?: boolean; icon?: string; onClick: () => void; children: ReactNode; label?: string; disabled?: boolean;
}) {
  return (
    <button type="button" className={`studio-chip${on ? " on" : ""}${prominent ? " prominent" : ""}`} aria-pressed={on}
            aria-label={label} onClick={onClick} disabled={disabled}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

const Sep = () => <span className="studio-sep" aria-hidden="true" />;

/**
 * Screen 8, the Studio: a board for plays in 2D and 3D. Simple shows the lineup bar (system, rotation, who serves,
 * play a rally), moving players, drawing and zones, and the eye view; Advanced adds the opponent's lineup, swapping
 * ends, more zone fills and sight lines.
 */
export function Studio({ boardId }: { boardId?: string }) {
  const go = useNav((s) => s.go);
  const advanced = useSettings((s) => s.advanced);
  const women = useSettings((s) => s.women);
  const themeId = useSettings((s) => s.themeId);
  // Net height and player statures follow Settings > Players (set before the scene's ball flights are solved).
  PlayerBodies.women = women;
  const st = useStudio();
  const [boxRef, box] = useBoxSize<HTMLDivElement>();
  const [dockRef, dock] = useBoxSize<HTMLDivElement>();
  const board3D = useRef<Board3D | null>(null);
  const [sheet, setSheet] = useState(false);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => { void useStudio.getState().open(boardId); }, [boardId]);

  // Undo and redo from a keyboard (Cmd-Z, Shift-Cmd-Z); playback stops when the coach leaves.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      const s = useStudio.getState();
      if (!s.editor) return;
      e.preventDefault();
      if (e.shiftKey) s.redo();
      else s.undo();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      const s = useStudio.getState();
      if (s.playing) s.togglePlay();
    };
  }, []);

  if (!st.editor) return <div className="screen"><Bar title="Studio" /><div className="empty">Opening the board…</div></div>;

  const scene = st.scene();
  const frame = st.frame();
  const timeline = scene.phases ?? [];
  const vertical = box.h > box.w * 1.1;
  // In 3D the strips float over the board; the camera centres the court in the part above them.
  const inset = st.view3D ? dock.h : 0;
  const selected = st.selectedToken ? frame.tokens.find((t) => t.id === st.selectedToken) : undefined;
  const povToken = st.pov ? frame.tokens.find((t) => t.id === st.pov) : undefined;
  const showHint = timeline.length === 0 && scene.zones.length === 0 && scene.ink.length === 0 && !st.selectedToken;
  const hint = st.tool === "pen" ? "Draw with one finger"
    : st.tool === "zone" ? "Draw a zone with one finger"
    : st.view3D ? "Drag a player to move them, or drag the floor to turn the court" : "Drag a player to move them, or play a rally below";
  const posed = st.view3D && st.gaze ? studioBodies(scene, st.time, frame) : undefined;
  const gaze = posed && st.gaze
    ? sightLines(posed, st.gaze, { id: st.pov, yaw: st.povYaw, pitch: st.povPitch }, st.ball(), box.w / Math.max(box.h, 1),
      st.gazeTargetList(posed))
    : undefined;
  const nameBoard = () => setNaming({ heading: "Name this board", label: "Name", value: scene.title, save: (v) => st.rename(v) });
  const namePlayer = (id: string, label: string) =>
    setNaming({ heading: "Name or shirt number", label: "Name or number", value: label, save: (v) => st.setLabel(id, v) });
  const alternative = st.alternative ? alternativeSpot(st.alternative.anchor, box, vertical, st.flipped, st.view3D ? board3D.current : null) : null;

  /** Back to 2D: the camera flies up to the view from above first, then the 2D board takes over. */
  const show2D = () => {
    if (!st.view3D || exiting) return;
    const b = board3D.current;
    if (!b) { st.set({ view3D: false }); return; }
    setExiting(true);
    b.leaveFirstPerson();
    b.setOrbit(studioOrbit(b.camera.aspect, st.flipped, true), true);
    window.setTimeout(() => {
      useStudio.getState().set({ view3D: false });
      setExiting(false);
    }, 760);
  };

  const resetView = () => {
    if (st.pov) { st.exitPOV(); return; }
    const b = board3D.current;
    if (b) b.setOrbit(studioOrbit(b.camera.aspect, st.flipped), true);
  };

  const tools: [StudioTool, string, string][] = [["move", "Move", "move"], ["pen", "Draw", "pen"], ["zone", "Zone", "zone"]];

  return (
    <div className="screen studio">
      <header className="bar studio-bar">
        <button className="btn home-btn" onClick={() => go({ name: "home" })} aria-label="Home">
          <Icon name="back" /><span className="studio-wide">Home</span>
        </button>
        <button className="studio-title" onClick={nameBoard} aria-label={`Rename this board: ${scene.title}`}>
          <span>{scene.title}</span><Icon name="pen" size={16} />
        </button>
        {advanced && <span className="studio-count">{scene.zones.length} zone{scene.zones.length === 1 ? "" : "s"}</span>}
        <span className="spacer" />
        {advanced && (
          <button className={`btn quiet${st.snapping ? " on" : ""}`} onClick={() => st.set({ snapping: !st.snapping })}
                  aria-pressed={st.snapping} aria-label="Snap to the court and the formation">
            <Icon name="magnet" /><span className="studio-wide">Snap</span>
          </button>
        )}
        {advanced && (
          <button className="btn quiet" onClick={() => st.set({ flipped: !st.flipped })} aria-label="Swap ends">
            <Icon name="swap" /><span className="studio-wide">Swap ends</span>
          </button>
        )}
        {st.view3D && (
          <button className="btn quiet" onClick={resetView} aria-label="Reset view">
            <Icon name="target" /><span className="studio-wide">Reset view</span>
          </button>
        )}
        <div className="studio-switch" role="group" aria-label={st.view3D ? "Showing 3D" : "Showing 2D"}>
          <button type="button" aria-pressed={!st.view3D} onClick={show2D} disabled={exiting}>2D</button>
          <button type="button" aria-pressed={st.view3D} onClick={() => st.set({ view3D: true })} disabled={exiting}>3D</button>
        </div>
        <button className="btn quiet" onClick={() => setSheet(true)} aria-label="Boards">
          <Icon name="stack" /><span className="studio-wide">Boards</span>
        </button>
      </header>

      <div className="studio-body">
        <nav className="studio-rail" aria-label="Tools">
          {tools.map(([t, title, icon]) => (
            <button key={t} type="button" className="studio-tool" aria-pressed={st.tool === t} onClick={() => st.set({ tool: t })}>
              <Icon name={icon} size={22} /><span>{title}</span>
            </button>
          ))}
          <hr />
          <button type="button" className="studio-tool" disabled={!st.editor.canUndo} onClick={() => st.undo()}>
            <Icon name="undo" size={22} /><span>Undo</span>
          </button>
          <button type="button" className="studio-tool" disabled={!st.editor.canRedo} onClick={() => st.redo()}>
            <Icon name="redo" size={22} /><span>Redo</span>
          </button>
          {st.selectedZone && (
            <button type="button" className="studio-tool" onClick={() => st.deleteSelection()}>
              <Icon name="trash" size={22} /><span>Delete</span>
            </button>
          )}
          {scene.ink.length > 0 && (
            <button type="button" className="studio-tool" onClick={() => st.clearInk()}>
              <Icon name="eraser" size={22} /><span>Erase</span>
            </button>
          )}
        </nav>

        <div className={`studio-main${st.view3D ? " floating" : ""}`}>
          <div className="studio-board" ref={boxRef}>
            {st.view3D
              ? <StudioBoard3D themeKey={themeId} netHeight={netHeight(women)} onBoard={(b) => { board3D.current = b; }}
                               inset={inset} size={box} />
              : <Board2D frame={frame} vertical={vertical} />}
            {showHint && <div className="hint-pill studio-hint" style={{ bottom: inset + 14 }}>{hint}</div>}
            {(st.tool === "zone" || st.selectedZone) && <ZoneStrip advanced={advanced} />}
            {st.view3D && st.pov && <FieldRings width={box.w} centerY={(box.h - inset) / 2} />}
            {gaze && (
              <div className="panel studio-gaze" role="status">
                <span className="studio-label">What they can see</span>
                {gaze.readouts.length === 0 && (
                  <span className="muted">{st.pov ? "Tap a player to check if they can be seen" : "No players to check"}</span>
                )}
                {gaze.readouts.map((r) => (
                  <div key={`${r.targetID}-${r.aim}`} className="studio-gaze-row">
                    <i style={{ background: r.visibility.fraction >= 0.5 ? "var(--c-text)" : "#FF3B1A" }} />{r.text}
                  </div>
                ))}
                {st.pov && (
                  <small className="muted">
                    Shows where the head points, not the eyes. The rings mark sharp and side vision. Tap a player to add or remove them.
                  </small>
                )}
              </div>
            )}
            {st.alternative && alternative && (
              <button type="button" className="studio-alt" style={{ left: alternative.x, top: alternative.y }}
                      onClick={() => st.acceptAlternative()} aria-label={`Make it a ${shapeName(st.alternative.kind).toLowerCase()}`}>
                {shapeName(st.alternative.kind)}?
              </button>
            )}
            {st.aimingLanding && <div className="hint-pill studio-aim">Tap the floor where the ball lands</div>}
          </div>

          <div className="studio-dock" ref={dockRef}>
            {(selected || (st.view3D && povToken)) && (
              <PlayerStrip advanced={advanced} onName={namePlayer} />
            )}
            {advanced && timeline.length > 0 && <BallStrip />}
            {(timeline.length > 0 || advanced) && <TimelineStrip advanced={advanced} />}
            {!st.pov && <LineupBar advanced={advanced} />}
          </div>
        </div>
      </div>

      {sheet && <BoardsSheet onClose={() => setSheet(false)} />}
      {naming && <NameSheet naming={naming} onClose={() => setNaming(null)} />}
    </div>
  );
}

const shapeNames: Record<ShapeKind, string> = {
  line: "Line", openPath: "Path", circle: "Circle", ellipse: "Ellipse", rect: "Rectangle", polygon: "Polygon", freeform: "Free shape",
};
const shapeName = (k: ShapeKind) => shapeNames[k];

/**
 * Where the alternative chip floats: above the zone's centre, on the 2D board (the SVG's view box fitted into the
 * board) or on the 3D board (the point through the camera).
 */
function alternativeSpot(anchor: { x: number; z: number }, box: { w: number; h: number }, vertical: boolean, flipped: boolean,
  board: Board3D | null): { x: number; y: number } | null {
  let p: { x: number; y: number } | null;
  if (board) p = board.screenPoint(new THREE.Vector3(anchor.x, 0, anchor.z));
  else {
    const m = 2.4, [w, h] = vertical ? [9 + 2 * m, 18 + 2 * m] : [18 + 2 * m, 9 + 2 * m];
    const k = Math.min(box.w / w, box.h / h), s = flipped ? -1 : 1;
    const u = vertical ? s * anchor.x : -s * anchor.z, v = vertical ? s * anchor.z : s * anchor.x;
    p = { x: box.w / 2 + u * k, y: box.h / 2 + v * k };
  }
  if (!p) return null;
  return { x: Math.max(60, Math.min(box.w - 60, p.x)), y: Math.max(24, p.y - 56) };
}

/**
 * The selected player: a name or shirt number (numbers show on the jersey in 3D), and in 3D the eye view (Section
 * 5.1); Advanced adds the sight lines.
 */
function PlayerStrip({ advanced, onName }: { advanced: boolean; onName: (id: string, label: string) => void }) {
  const st = useStudio();
  const frame = st.frame();
  const selected = st.selectedToken ? frame.tokens.find((t) => t.id === st.selectedToken) : undefined;
  const povToken = st.pov ? frame.tokens.find((t) => t.id === st.pov) : undefined;
  if (st.view3D && povToken) {
    return (
      <div className="panel studio-emphasis">
        <span className="studio-label">Eye view of {povToken.label}</span>
        <Chip on={st.povYaw === 0 && st.povPitch === 0} onClick={() => st.look(st.povYaw, -st.povPitch)}>Look ahead</Chip>
        {selected && selected.id !== povToken.id && <Chip icon="eye" onClick={() => st.enterPOV()}>Switch to {selected.label}</Chip>}
        <Chip on={st.gaze === povToken.id} onClick={() => useStudio.setState({ gaze: st.gaze === povToken.id ? undefined : povToken.id })}>
          Sight lines
        </Chip>
        <Chip icon="close" prominent onClick={() => st.exitPOV()}>Leave eye view</Chip>
      </div>
    );
  }
  if (!selected) return null;
  return (
    <div className="panel studio-emphasis">
      <strong className="studio-player">{selected.label}</strong>
      <Chip icon="pen" onClick={() => onName(selected.id, selected.label)} label={`Name or shirt number of ${selected.label}`}>
        Name or number
      </Chip>
      {st.view3D && (
        <Chip icon="eye" prominent onClick={() => st.enterPOV()} label={`See through the eyes of ${selected.label}`}>
          See what {selected.label} sees
        </Chip>
      )}
      {st.view3D && advanced && <Chip on={st.gaze === selected.id} onClick={() => st.toggleGaze()}>Sight lines</Chip>}
      {st.view3D && advanced && <><Sep /><PostureChips /></>}
    </div>
  );
}

/** Posture chips for the selected player in 3D (Section 5.2's library), at the current marker; they scroll. */
function PostureChips() {
  const st = useStudio();
  const explicit = st.selectedPosture();
  return (
    <div className="studio-body-chips">
      <span className="studio-label">Body</span>
      <div className="studio-scroll">
        <Chip on={explicit === undefined} onClick={() => st.setPosture(undefined)}>Auto</Chip>
        {postureOrder.map((p) => (
          <Chip key={p} on={explicit === p} onClick={() => st.setPosture(p)}>{sentenceCase(Posture.title(p))}</Chip>
        ))}
      </div>
    </div>
  );
}

/**
 * Ball contacts at the current marker (Section 5.4): who plays the ball and how; the physics flies it to the next
 * contact. The readout describes the flight in the air now.
 */
function BallStrip() {
  const st = useStudio();
  const phase = st.currentPhase();
  const selected = st.selectedToken ? st.scene().tokens.find((t) => t.id === st.selectedToken) : undefined;
  const contact = st.currentContact();
  const summary = st.ballSummary();
  return (
    <div className="panel">
      <span className="studio-label">Ball</span>
      {phase && selected ? (
        contact?.player === selected.id ? (
          <>
            {ContactKind.choices(phase).map((k) => (
              <Chip key={k} on={k === contact.kind} onClick={() => st.setContact(k)}>{contactName[k]}</Chip>
            ))}
            <Chip onClick={() => st.removeContact()}>No ball</Chip>
            {st.currentContactIsLast() && (
              <Chip icon="target" on={st.aimingLanding} onClick={() => st.aimLanding()}>{st.aimingLanding ? "Tap the floor" : "Aim"}</Chip>
            )}
          </>
        ) : (
          <Chip onClick={() => st.setContact()}>{contact ? `${selected.label} plays it instead` : `${selected.label} plays it`}</Chip>
        )
      ) : !st.scene().contacts?.length && (
        <span className="muted">Pick a player on a phase to give them the ball</span>
      )}
      {summary && <span className="mono studio-summary">{summary}</span>}
    </div>
  );
}

/**
 * The rally timeline (Section 3.5.7): play, the phase markers and (Advanced) the selected item's keyframe at the
 * marker. Edits made while resting on a later marker become keyframes there; the first marker holds the base scene.
 */
function TimelineStrip({ advanced }: { advanced: boolean }) {
  const st = useStudio();
  const timeline = st.scene().phases ?? [];
  if (timeline.length === 0) {
    return (
      <div className="panel">
        <Chip icon="film" onClick={() => st.enableTimeline()} label="Animate by phase: players and zones can then change per phase">
          Animate by phase
        </Chip>
      </div>
    );
  }
  const shown = Math.round(st.time);
  const phase = st.currentPhase();
  const editing = advanced && (st.selectedToken || st.selectedZone) && phase && timeline[0] !== phase;
  const hidden = st.selectedZone ? (st.frame().intensities.get(st.selectedZone) ?? 1) < 0.5 : false;
  return (
    <div className="panel">
      <button type="button" className="studio-chip prominent studio-play" onClick={() => st.togglePlay()}
              aria-label={st.playing ? "Pause" : "Play the rally"}>
        <Icon name={st.playing ? "pause" : "play"} />
      </button>
      {timeline.map((p, i) => (
        <Chip key={p} on={shown === i} onClick={() => st.goTo(p)}>
          {phaseName[p]}
          {advanced && <span className={`studio-dot${st.selectionHasKey(p) ? " on" : ""}`} aria-hidden="true" />}
        </Chip>
      ))}
      {editing && (
        <>
          <Sep />
          {st.selectionHasKey(phase)
            ? <Chip onClick={() => st.clearSelectionKey()}>Clear key</Chip>
            : <Chip onClick={() => st.pinSelection()}>Hold here</Chip>}
          {st.selectedZone && <Chip on={hidden} onClick={() => st.toggleZoneVisibility()}>{hidden ? "Show" : "Hide"}</Chip>}
        </>
      )}
      <Sep />
      {advanced
        ? <Chip onClick={() => st.disableTimeline()} label="Static: back to one picture without phases">Static</Chip>
        : <Chip icon="close" onClick={() => st.backToLineup()}>Clear rally</Chip>}
    </div>
  );
}

/**
 * The lineup in one row (the Studio's main control): the system, the rotation (the arrow moves on as after a
 * side-out), who serves, and one tap to play a rally out. Advanced adds the opponent's system and rotation.
 */
function LineupBar({ advanced }: { advanced: boolean }) {
  const st = useStudio();
  const setup = st.setup();
  const playing = (st.scene().phases ?? []).length > 0;
  return (
    <div className="panel studio-lineup">
      <div className="studio-group">
        <SystemMenu side="home" title={advanced ? "Us" : undefined} />
        <RotationStepper side="home" rotation={setup.homeRotation} advanced={advanced} />
        <span className="studio-label">Serve</span>
        <Chip on={setup.homeServes} onClick={() => { if (!setup.homeServes) st.changeSetup((s) => ({ ...s, homeServes: true })); }}>Us</Chip>
        <Chip on={!setup.homeServes} onClick={() => { if (setup.homeServes) st.changeSetup((s) => ({ ...s, homeServes: false })); }}>Them</Chip>
        {advanced && (
          <>
            <Sep />
            <SystemMenu side="opponent" title="Them" />
            <RotationStepper side="opponent" rotation={setup.opponentRotation} advanced={advanced} />
          </>
        )}
      </div>
      <div className="studio-group">
        <span className="studio-label">Play a rally</span>
        {AttackOption.allCases.map((a) => {
          const current = playing && setup.attack === a;
          return (
            <Chip key={a} on={current} icon={current ? "play" : undefined} onClick={() => st.playRally(a)}
                  label={`Play a rally with the attack on the ${AttackOption.title(a).toLowerCase()}`}>
              {AttackOption.title(a)}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}

/** The system as a menu (the device's own picker); choosing one starts in its first rotation. */
function SystemMenu({ side, title }: { side: Side; title?: string }) {
  const st = useStudio();
  const current = TeamSystem.fromRawValue(SceneSetup.system(st.setup(), side)) ?? TeamSystem.fiveOneOutside;
  const choose = (id: string) => {
    const r = rotationsOf(id)[0] ?? 1;
    st.changeSetup((s) => (side === "home" ? { ...s, homeSystem: id, homeRotation: r } : { ...s, opponentSystem: id, opponentRotation: r }));
  };
  return (
    <label className="studio-select">
      {title && <span className="studio-label">{title}</span>}
      <strong>{systemShortName[current]}</strong>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      <select value={current} onChange={(e) => choose(e.target.value)}
              aria-label={side === "home" ? `Our system: ${TeamSystem.displayName(current)}` : `Their system: ${TeamSystem.displayName(current)}`}>
        {TeamSystem.allCases.map((s) => <option key={s} value={s}>{TeamSystem.displayName(s)}</option>)}
      </select>
    </label>
  );
}

function RotationStepper({ side, rotation, advanced }: { side: Side; rotation: number; advanced: boolean }) {
  const st = useStudio();
  const many = st.rotations(side).length > 1;
  return (
    <div className="studio-stepper" style={{ opacity: many ? 1 : 0.5 }}>
      <button type="button" onClick={() => st.rotate(side, false)} disabled={!many} aria-label="Previous rotation">
        <Icon name="chevronLeft" />
      </button>
      <div>
        <strong>{rotation === 0 ? "Any rotation" : `Rotation ${rotation}`}</strong>
        {advanced && rotation > 0 && <small>setter in zone {rotation}</small>}
      </div>
      <button type="button" onClick={() => st.rotate(side, true)} disabled={!many} aria-label="Next rotation, as after a side-out">
        <Icon name="chevronRight" />
      </button>
    </div>
  );
}

/**
 * The zone controls, one strip one level deep (W3): they edit the selected zone, or set the defaults for the next
 * stroke. Simple shows a fill and whose colour; Advanced adds the shape, density, angle, edge and the tag.
 */
function ZoneStrip({ advanced }: { advanced: boolean }) {
  const st = useStudio();
  const zone = st.selectedZone ? st.scene().zones.find((z) => z.id === st.selectedZone) : undefined;
  const style = st.stripStyle();
  const [density, setDensity] = useState<number | null>(null);
  const patterns: [string, ZonePattern][] = [
    ...(advanced ? [["Cross", "crossHatch"] as [string, ZonePattern]] : []),
    ["Lines", "diagonal"], ["Dots", "dots"], ["Glow", "glowFill"], ["Outline", "outline"],
  ];
  const fills = patterns.map(([title, p]) => <Chip key={p} on={style.pattern === p} onClick={() => st.updateStyle(p)}>{title}</Chip>);
  const tints = (
    <>
      <Chip on={style.tint === "pink"} onClick={() => st.updateStyle(undefined, "pink")}>Ours</Chip>
      <Chip on={style.tint === "cyan"} onClick={() => st.updateStyle(undefined, "cyan")}>Theirs</Chip>
    </>
  );
  const del = zone && <Chip icon="trash" onClick={() => st.deleteSelection()}>Delete</Chip>;
  if (!advanced) {
    return (
      <div className="panel studio-emphasis studio-zones">
        <span className="studio-label">{zone ? "Zone" : "Draw a zone"}</span>
        {fills}
        <Sep />
        {tints}
        {del && <><Sep />{del}</>}
      </div>
    );
  }
  const shapes: [string, ShapeKind | undefined][] = [
    ["Auto", undefined], ["Rectangle", "rect"], ["Circle", "circle"], ["Ellipse", "ellipse"], ["Polygon", "polygon"], ["Free", "freeform"],
  ];
  const tags: [string, ZoneTag][] = [
    ["No-fly", "noFly"], ["Serve target", "serveTarget"], ["Tip alert", "tipAlert"], ["Free ball", "freeBall"],
    ["Responsibility", "responsibility"], ["Custom", "custom"],
  ];
  const tag = st.stripTag();
  const deg = Math.round((style.angle * 180) / Math.PI);
  const commitDensity = () => {
    if (density !== null) st.editStyle((s) => ({ ...s, spacing: 0.75 - density }));
    setDensity(null);
  };
  const row = (title: string, children: ReactNode) => (
    <div className="studio-zone-row"><span className="studio-label">{title}</span><div className="studio-scroll">{children}</div></div>
  );
  return (
    <div className="panel studio-emphasis studio-zones studio-zones-full">
      {row("Shape", shapes.map(([title, k]) => (
        <Chip key={title} on={st.forcedShape === k} onClick={() => st.setShape(k)}>{title}</Chip>
      )))}
      {row("Fill", fills)}
      {row("Density", (
        <>
          <input type="range" min={0.15} max={0.6} step={0.01} aria-label="Density"
                 value={density ?? 0.75 - style.spacing}
                 onPointerDown={() => setDensity(0.75 - style.spacing)}
                 onChange={(e) => {
                   const v = Number(e.target.value);
                   if (density === null) st.editStyle((s) => ({ ...s, spacing: 0.75 - v }));
                   else setDensity(v);
                 }}
                 onPointerUp={commitDensity} onPointerCancel={commitDensity} />
          <span className="mono studio-angle">Angle {deg}°</span>
          <Chip onClick={() => st.editStyle((s) => ({ ...s, angle: s.angle - Math.PI / 12 }))} label="Turn the lines back 15 degrees">−</Chip>
          <Chip onClick={() => st.editStyle((s) => ({ ...s, angle: s.angle + Math.PI / 12 }))} label="Turn the lines on 15 degrees">+</Chip>
        </>
      ))}
      {row("Edge", (
        <>
          <Chip on={style.edge === "solid"} onClick={() => st.editStyle((s) => ({ ...s, edge: "solid" }))}>Solid</Chip>
          <Chip on={style.edge === "dashed"} onClick={() => st.editStyle((s) => ({ ...s, edge: "dashed" }))}>Dashed</Chip>
          <Sep />
          {tints}
        </>
      ))}
      {row("Tag", tags.map(([title, t]) => <Chip key={t} on={tag === t} onClick={() => st.setTag(t)}>{title}</Chip>))}
      <div className="studio-zone-row">
        <span className="muted studio-note">{zone ? "Editing the selected zone" : "Settings for the next zone you draw"}</span>
        {del}
      </div>
    </div>
  );
}

/**
 * In eye view, thin rings mark the central field (30 degrees) and the sharp core (2.5 degrees) (Section 5.7). With a
 * 90 degree horizontal field of view, an angle theta from the centre sits at (width / 2) * tan(theta).
 */
function FieldRings({ width, centerY }: { width: number; centerY: number }) {
  const half = width / 2;
  const central = half * Math.tan((30 * Math.PI) / 180), foveal = half * Math.tan((2.5 * Math.PI) / 180);
  return (
    <div className="studio-rings" aria-hidden="true" style={{ bottom: "auto", height: centerY * 2 }}>
      <span style={{ width: central * 2, height: central * 2, borderColor: "color-mix(in srgb, var(--c-accent) 55%, transparent)", borderWidth: 1.5 }} />
      <span style={{ width: foveal * 2, height: foveal * 2, borderColor: "color-mix(in srgb, var(--c-text) 70%, transparent)" }} />
    </div>
  );
}

/** Boards: start a new one from a formation, open or delete a saved one. */
function BoardsSheet({ onClose }: { onClose: () => void }) {
  const st = useStudio();
  const current = st.editor?.scene.id;
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [system, setSystem] = useState<TeamSystem>(TeamSystem.fiveOneOutside);
  const [rotation, setRotation] = useState(1);
  const [weServe, setWeServe] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const rotations = rotationsOf(system);

  const refresh = () => { listBoards().then(setBoards).catch(() => setBoards([])); };
  useEffect(refresh, []);

  const create = async () => {
    const r = rotations.includes(rotation) ? rotation : rotations[0] ?? 1;
    await st.newBoard(SceneSetup.create({ homeSystem: system, homeRotation: r, homeServes: weServe }));
    onClose();
  };

  return (
    <div className="studio-sheet" onClick={onClose}>
      <div className="card stack" role="dialog" aria-label="Boards" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="title" style={{ fontSize: 34 }}>Boards</h2>
          <button className="btn secondary" onClick={onClose}>Done</button>
        </div>
        <section className="stack" style={{ gap: 12 }}>
          <h3 className="group-title" style={{ margin: 0 }}>New board</h3>
          <label className="field">
            <span className="label">System</span>
            <select value={system} onChange={(e) => setSystem(e.target.value as TeamSystem)}>
              {TeamSystem.allCases.map((s) => <option key={s} value={s}>{TeamSystem.displayName(s)}</option>)}
            </select>
          </label>
          {rotations.length > 1 && (
            <div className="field">
              <span className="label">Rotation</span>
              <Choice label="Rotation" value={rotations.includes(rotation) ? rotation : rotations[0]} onChange={setRotation}
                      options={rotations.map((r) => ({ value: r, title: String(r) }))} />
            </div>
          )}
          <div className="field">
            <span className="label">We</span>
            <Choice label="We receive or serve" value={weServe} onChange={setWeServe}
                    options={[{ value: false, title: "Receive" }, { value: true, title: "Serve" }]} />
          </div>
          <div><button className="btn primary" onClick={() => void create()}><Icon name="plus" /> Create board</button></div>
        </section>
        {boards.length > 0 && (
          <section className="stack" style={{ gap: 12 }}>
            <h3 className="group-title" style={{ margin: 0 }}>Saved boards</h3>
            <div className="list">
              {boards.map((b) => (
                <div key={b.id}>
                  <button className="btn quiet" style={{ flex: 1, justifyContent: "flex-start", textAlign: "left", padding: 0 }}
                          onClick={() => { void st.open(b.id).then(onClose); }}>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                      <strong>{b.title}{b.id === current ? " (open)" : ""}</strong>
                      <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
                        {new Date(b.modifiedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </span>
                  </button>
                  {b.id !== current && (
                    confirm === b.id
                      ? <button className="btn danger small" onClick={() => { void deleteBoard(b.id).then(refresh); setConfirm(null); }}>Delete for good</button>
                      : <button className="btn quiet small" onClick={() => setConfirm(b.id)} aria-label={`Delete ${b.title}`}><Icon name="trash" /></button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function NameSheet({ naming, onClose }: { naming: Naming; onClose: () => void }) {
  const [value, setValue] = useState(naming.value);
  return (
    <div className="studio-sheet" onClick={onClose}>
      <form className="card stack" role="dialog" aria-label={naming.heading} style={{ width: "min(460px, 100%)" }}
            onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); naming.save(value); onClose(); }}>
        <h2 className="group-title" style={{ margin: 0 }}>{naming.heading}</h2>
        <label className="field">
          <span className="label">{naming.label}</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="btn primary" disabled={!value.trim()}>Save</button>
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
