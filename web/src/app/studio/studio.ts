import { create } from "zustand";
import type { FloorPoint, Side } from "../../core/match/court";
import { InkStroke } from "../../core/match/liveTypes";
import {
  Gaze, PlayerBodies, SeparationTrack, posedPlayers, separateBodies, type GazeAim, type PosedPlayer, type Posture,
} from "../../core/spatial";
import {
  ContactKind, PlacementAssist, SceneEditor, SceneSetup, SmartGeometry, TacticalScene, Zone, ZoneBuilder, ZoneSnapping, ZoneStyle,
  ZoneTag, sceneClock, sceneFrame, sceneMotion, sceneTimeline, templateRotations,
  type AttackOption, type BallContact, type BallPlan, type RallyPhase, type SceneFrame, type ShapeKind, type SnapTarget,
  type ZonePattern, type ZoneTint,
} from "../../core/zones";
import { loadTemplate } from "../../core/zones/templateAccess";
import { all, get, put, remove } from "../store/db";

/** A Studio board as stored on the device: the scene in the iPad app's JSON shape. */
export interface BoardRecord {
  id: string;
  title: string;
  modifiedAt: string;
  scene: Record<string, unknown>;
}

export type StudioTool = "move" | "pen" | "zone";

/** The markers "Animate by phase" adds, serve to defence. */
const RallyPhaseOrder: readonly RallyPhase[] = ["serve", "receive", "set", "attack", "cover", "defence"];


let planCache: { scene: TacticalScene; net: number; plan: BallPlan } | undefined;

/** The ball's flights for a scene (solving them is expensive, so one plan is kept per scene value). */
export function ballPlanOf(scene: TacticalScene): BallPlan {
  const net = PlayerBodies.netHeight;
  if (planCache && planCache.scene === scene && planCache.net === net) return planCache.plan;
  const plan = TacticalScene.ballPlan(scene, net);
  planCache = { scene, net, plan };
  return plan;
}

let bodyCache: { scene: TacticalScene; women: boolean; athletes: boolean; track: SeparationTrack } | undefined;

/** Floor velocities (m/s) of a scene's players at a timeline position, as the scene plays (sceneMotion). */
function velocities(scene: TacticalScene, time: number): Map<string, FloorPoint> {
  return new Map([...sceneMotion(scene, time)].map(([id, m]) => [id, m.velocity]));
}

/**
 * The players of a moment of the scene as bodies that never stand in each other or reach through the net (web
 * addition): posed, slid aside along the rally (one SeparationTrack per scene, so they step around each other rather
 * than jump), and any touch left in this exact frame (a drag included) resolved. The dragged player stands firm.
 * Players taking steps are kept apart by their whole step cycle (PosedPlayer.strideEnvelope).
 */
export function studioBodies(scene: TacticalScene, time: number, frame: SceneFrame, dragged?: string): PosedPlayer[] {
  const posed = posedPlayers(frame);
  const line = sceneTimeline(scene);
  if (line.length === 0) return separateBodies(posed, { weight: (p) => (p.id === dragged ? 0 : 1) });
  const women = PlayerBodies.women, athletes = PlayerBodies.athletes;
  if (!bodyCache || bodyCache.scene !== scene || bodyCache.women !== women || bodyCache.athletes !== athletes) {
    const plan = ballPlanOf(scene);
    const clock = sceneClock(scene);
    const track = new SeparationTrack((seconds) => {
      const t = clock.time(seconds);
      const f = TacticalScene.liveFrame(scene, t, plan);
      const velocity = velocities(scene, t);
      return { players: posedPlayers(f), velocity, weight: (p) => 0.3 + Math.hypot(velocity.get(p.id)!.x, velocity.get(p.id)!.z) };
    }, 0, clock.total, {
      floor: (seconds) => new Map(sceneFrame(scene, clock.time(seconds)).tokens.map((t) => [t.id, t.point])),
    });
    bodyCache?.track.stop();
    track.prepare();
    bodyCache = { scene, women, athletes, track };
  }
  const velocity = velocities(scene, time);
  const speed = (id: string) => Math.hypot(velocity.get(id)?.x ?? 0, velocity.get(id)?.z ?? 0);
  return separateBodies(posed, { weight: (p) => (p.id === dragged ? 0 : 0.3 + speed(p.id)), velocity: (p) => velocity.get(p.id) },
    bodyCache.track.offsets(sceneClock(scene).seconds(time)));
}

interface StudioState {
  editor?: SceneEditor;
  /** Changes after every edit so views redraw. */
  version: number;
  tool: StudioTool;
  selectedToken?: string;
  selectedZone?: string;
  /** Timeline position in phase-index units; markers sit at whole numbers. */
  time: number;
  playing: boolean;
  view3D: boolean;
  /** The player whose eyes the 3D camera uses. */
  pov?: string;
  povYaw: number;
  povPitch: number;
  /** Whose sight lines are shown (Advanced). */
  gaze?: string;
  /** Explicit sight-line targets of the gaze player; undefined uses the read cues (setter's head, hitters' shoulders). */
  gazeTargets?: Record<string, GazeAim>;
  /** Style, tag and shape (undefined: recognized) for the next zone drawn. */
  zoneStyle: ZoneStyle;
  zoneTag: ZoneTag;
  forcedShape?: ShapeKind;
  /** Drop help: zones snap to the court and players to the formation's spots (Advanced can turn it off). */
  snapping: boolean;
  /** The next floor tap sets where the last ball flight lands. */
  aimingLanding: boolean;
  /** The one-tap alternative after an uncertain recognition (4 s). */
  alternative?: { kind: ShapeKind; stroke: FloorPoint[]; zoneId: string; anchor: FloorPoint };
  /** What a drop or a zone snapped to, shown briefly. */
  highlights: SnapTarget[];
  /** Home on the left of the 2D court (Swap ends turns it). */
  flipped: boolean;
  open(boardId?: string): Promise<void>;
  /** A new board, its players placed from a setup (the default: 5-1, rotation 1, they serve). */
  newBoard(setup?: SceneSetup): Promise<void>;
  scene(): TacticalScene;
  setup(): SceneSetup;
  frame(): SceneFrame;
  ball(): { x: number; y: number; z: number } | undefined;
  currentPhase(): RallyPhase | undefined;
  rotations(side: Side): number[];
  set(change: Partial<Pick<StudioState, "tool" | "view3D" | "flipped" | "snapping">>): void;
  changeSetup(change: (s: SceneSetup) => SceneSetup): void;
  rotate(side: Side, forward: boolean): void;
  playRally(attack: AttackOption): void;
  backToLineup(): void;
  togglePlay(): void;
  goTo(phase: RallyPhase): void;
  select(token?: string, zone?: string): void;
  moveToken(id: string, p: FloorPoint): void;
  moveZone(id: string, dx: number, dz: number): void;
  addInk(points: FloorPoint[]): void;
  clearInk(): void;
  addZone(stroke: FloorPoint[]): void;
  updateStyle(pattern?: ZonePattern, tint?: ZoneTint): void;
  /** Changes the selected zone's style, or the defaults for the next zone. */
  editStyle(change: (s: ZoneStyle) => ZoneStyle): void;
  /** The style and tag the zone strip shows: the selected zone's, or the defaults. */
  stripStyle(): ZoneStyle;
  stripTag(): ZoneTag;
  setTag(tag: ZoneTag): void;
  /** A shape for the next zone (undefined: recognized); with a zone selected, its outline is refitted. */
  setShape(kind?: ShapeKind): void;
  acceptAlternative(): void;
  enableTimeline(): void;
  disableTimeline(): void;
  /** Whether the selected player or zone has a keyframe at a marker. */
  selectionHasKey(phase: RallyPhase): boolean;
  /** Keeps the selected player or zone at the current marker as shown. */
  pinSelection(): void;
  clearSelectionKey(): void;
  toggleZoneVisibility(): void;
  /** The posture set by hand for the selected player at the current marker (undefined: automatic). */
  selectedPosture(): Posture | undefined;
  setPosture(posture?: Posture): void;
  currentContact(): BallContact | undefined;
  currentContactIsLast(): boolean;
  /** The selected player plays the ball at the current marker (its default kind), or changes the kind. */
  setContact(kind?: ContactKind): void;
  removeContact(): void;
  aimLanding(): void;
  /** The flight in the air now, in words ("HIGH SET · apex 5.9 m · 1.48 s"). */
  ballSummary(): string | undefined;
  /** A tap on the floor; true when it was taken (aiming the ball's landing). */
  tapFloor(p: FloorPoint): boolean;
  /** Renames a player (a shirt number shows on their jersey in 3D). */
  setLabel(id: string, label: string): void;
  /** Adds or removes a player as a sight-line target of the gaze player. */
  toggleGazeTarget(id: string): void;
  gazeTargetList(players: readonly PosedPlayer[]): [string, GazeAim][];
  deleteSelection(): void;
  undo(): void;
  redo(): void;
  rename(title: string): void;
  enterPOV(id?: string): void;
  exitPOV(): void;
  look(dx: number, dy: number): void;
  toggleGaze(): void;
}

let saveTimer: number | undefined;
let queue: Promise<void> = Promise.resolve();

/** Opening and creating boards run one after another, so two quick opens never make two new boards. */
function serially(job: () => Promise<void>): Promise<void> {
  queue = queue.then(job, job);
  return queue;
}

let tween: number | undefined;
let alternativeTimer: number | undefined;
let highlightTimer: number | undefined;

function stopTween() {
  if (tween !== undefined) cancelAnimationFrame(tween);
  tween = undefined;
}

export const useStudio = create<StudioState>((set, getState) => {
  /** After an edit: redraw, drop a selection that no longer exists, save soon. */
  const edited = () => {
    const s = getState();
    const scene = s.editor!.scene;
    const keepToken = s.selectedToken && scene.tokens.some((t) => t.id === s.selectedToken) ? s.selectedToken : undefined;
    const keepZone = s.selectedZone && scene.zones.some((z) => z.id === s.selectedZone) ? s.selectedZone : undefined;
    set({ version: s.version + 1, selectedToken: keepToken, selectedZone: keepZone });
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveTimer = undefined; void save(); }, 500);
  };

  const save = async () => {
    const scene = getState().editor?.scene;
    if (!scene) return;
    const record: BoardRecord = { id: scene.id, title: scene.title, modifiedAt: new Date().toISOString(), scene: TacticalScene.encode(scene) };
    await put("boards", record);
  };

  /** Moves the time to `target` over `duration` seconds; `at` maps the fraction done to the time (default: evenly). */
  const tweenTo = (target: number, duration: number, playback = false, at?: (f: number) => number) => {
    stopTween();
    const start = getState().time;
    const begin = performance.now();
    const step = (now: number) => {
      const f = duration > 0 ? Math.min(1, (now - begin) / (duration * 1000)) : 1;
      set({ time: f >= 1 ? target : at ? at(f) : start + (target - start) * f });
      if (f < 1) tween = requestAnimationFrame(step);
      else {
        tween = undefined;
        if (playback) set({ playing: false });
      }
    };
    tween = requestAnimationFrame(step);
  };

  /** Writes a pending save now (before another board replaces this one). */
  const flush = async () => {
    if (saveTimer === undefined) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    await save();
  };

  const createBoard = async (setup?: SceneSetup) => {
    resetPlayers();
    const count = (await all<BoardRecord>("boards").catch(() => [])).length;
    const scene = TacticalScene.placed(`Board ${count + 1}`, setup ?? SceneSetup.create());
    set({ editor: new SceneEditor(scene), selectedToken: undefined, selectedZone: undefined, version: getState().version + 1 });
    await save();
  };

  const resetPlayers = () => {
    stopTween();
    set({ time: 0, playing: false, pov: undefined, gaze: undefined, gazeTargets: undefined, aimingLanding: false });
  };

  const show = (hits: SnapTarget[]) => {
    if (highlightTimer !== undefined) clearTimeout(highlightTimer);
    set({ highlights: hits });
    if (hits.length) highlightTimer = window.setTimeout(() => set({ highlights: [] }), 700);
  };

  const offerAlternative = (alt: StudioState["alternative"]) => {
    if (alternativeTimer !== undefined) clearTimeout(alternativeTimer);
    set({ alternative: alt });
    if (alt) alternativeTimer = window.setTimeout(() => set({ alternative: undefined }), 4000);
  };

  /** The selected zone as shown at this moment (keyframes and morphs applied). */
  const shownZone = (): Zone | undefined => {
    const s = getState();
    return s.selectedZone ? s.frame().zones.find((z) => z.id === s.selectedZone) : undefined;
  };

  return {
    version: 0,
    tool: "move",
    time: 0,
    playing: false,
    view3D: false,
    povYaw: 0,
    povPitch: 0,
    zoneStyle: ZoneStyle.create(),
    zoneTag: "custom",
    snapping: true,
    aimingLanding: false,
    highlights: [],
    flipped: false,

    open(boardId) {
      return serially(async () => {
        await flush();
        resetPlayers();
        let record: BoardRecord | undefined;
        if (boardId) record = await get<BoardRecord>("boards", boardId);
        if (!record) {
          const boards = await all<BoardRecord>("boards").catch(() => []);
          record = boards.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
        }
        if (!record) return createBoard();
        set({ editor: new SceneEditor(TacticalScene.decode(record.scene)), selectedToken: undefined, selectedZone: undefined,
          version: getState().version + 1 });
      });
    },

    newBoard(setup) {
      return serially(async () => {
        await flush();
        await createBoard(setup);
      });
    },

    scene() {
      return getState().editor!.scene;
    },

    setup() {
      return getState().editor?.scene.setup ?? SceneSetup.create();
    },

    frame() {
      const { editor, time } = getState();
      const scene = editor!.scene;
      return TacticalScene.liveFrame(scene, time, sceneTimeline(scene).length ? ballPlanOf(scene) : undefined);
    },

    ball() {
      const { editor, time } = getState();
      const scene = editor!.scene;
      if (!sceneTimeline(scene).length) return undefined;
      const p = ballPlanOf(scene).position(time);
      return p ? { x: p.x, y: p.y, z: p.z } : undefined;
    },

    currentPhase() {
      const { editor, time } = getState();
      const line = sceneTimeline(editor!.scene);
      const i = Math.round(time);
      if (!line.length || Math.abs(time - i) > 1e-6 || i >= line.length) return undefined;
      return line[i];
    },

    rotations(side) {
      const t = loadTemplate(SceneSetup.system(getState().setup(), side));
      return t ? templateRotations(t) : [1];
    },

    set(change) {
      if (change.view3D === false) set({ pov: undefined });
      set(change);
    },

    changeSetup(change) {
      resetPlayers();
      getState().editor!.place(change(getState().setup()));
      edited();
    },

    rotate(side, forward) {
      resetPlayers();
      getState().editor!.rotate(side, forward);
      edited();
    },

    playRally(attack) {
      resetPlayers();
      getState().editor!.playOut(attack);
      edited();
      getState().togglePlay();
    },

    backToLineup() {
      resetPlayers();
      getState().editor!.place(getState().setup());
      edited();
    },

    togglePlay() {
      const s = getState();
      if (s.playing) {
        stopTween();
        set({ playing: false, time: Math.round(s.time) });
        return;
      }
      const end = Math.max(sceneTimeline(s.editor!.scene).length - 1, 0);
      if (s.time >= end - 1e-6) set({ time: 0 });
      set({ playing: true });
      // In real time: a phase with a long run plays longer (sceneClock).
      const clock = sceneClock(s.editor!.scene);
      const from = clock.seconds(getState().time), left = clock.total - from;
      tweenTo(end, left, true, (f) => clock.time(from + f * left));
    },

    goTo(phase) {
      const s = getState();
      const target = TacticalScene.time(s.editor!.scene, phase);
      if (target === undefined) return;
      set({ playing: false });
      tweenTo(target, 0.45 * Math.sqrt(Math.max(1, Math.abs(target - s.time))));
    },

    select(token, zone) {
      offerAlternative(undefined);
      set({ selectedToken: token, selectedZone: zone });
    },

    moveToken(id, p) {
      const s = getState();
      const scene = s.editor!.scene;
      const token = scene.tokens.find((t) => t.id === id);
      if (!token) return;
      let point = p;
      if (s.snapping) {
        // Onto a formation spot when close, and never inside a teammate.
        const others = s.frame().tokens.filter((t) => t.side === token.side);
        const r = PlacementAssist.adjust(p, id, token.side, others, PlacementAssist.spots(token.side, scene.setup));
        point = r.point;
        if (r.snapped) show([{ kind: "point", point: r.snapped }]);
      }
      s.editor!.moveToken(id, point, s.currentPhase());
      edited();
    },

    moveZone(id, dx, dz) {
      const s = getState();
      s.editor!.moveZone(id, dx, dz, s.currentPhase());
      edited();
    },

    addInk(points) {
      if (points.length < 2) return;
      getState().editor!.addInk(InkStroke.make(points));
      edited();
    },

    clearInk() {
      getState().editor!.clearInk();
      edited();
    },

    addZone(stroke) {
      const s = getState();
      if (stroke.length < 6) return;
      const frame = s.frame();
      const built = ZoneBuilder.build(stroke, {
        forced: s.forcedShape, tag: s.zoneTag, style: s.zoneStyle, snapping: s.snapping,
        tokens: frame.tokens.map((t) => t.point), otherZones: frame.zones,
      });
      if (!built) return;
      s.editor!.addZone(built.zone);
      edited();
      set({ selectedZone: built.zone.id, selectedToken: undefined });
      show(built.snapped);
      offerAlternative(built.alternative
        ? { kind: built.alternative, stroke: [...stroke], zoneId: built.zone.id, anchor: Zone.centroid(built.zone) }
        : undefined);
    },

    acceptAlternative() {
      const s = getState();
      const alt = s.alternative;
      const old = alt ? s.editor!.scene.zones.find((z) => z.id === alt.zoneId) : undefined;
      offerAlternative(undefined);
      if (!alt || !old) return;
      const built = ZoneBuilder.build(alt.stroke, {
        forced: alt.kind, tag: old.semantic.tag, style: old.style, snapping: s.snapping,
        tokens: s.frame().tokens.map((t) => t.point), otherZones: s.editor!.scene.zones.filter((z) => z.id !== old.id),
      });
      if (!built) return;
      s.editor!.replaceZone({ ...built.zone, id: old.id });
      edited();
      show(built.snapped);
    },

    stripStyle() {
      const s = getState();
      return (s.selectedZone && s.editor?.scene.zones.find((z) => z.id === s.selectedZone)?.style) || s.zoneStyle;
    },

    stripTag() {
      const s = getState();
      return (s.selectedZone && s.editor?.scene.zones.find((z) => z.id === s.selectedZone)?.semantic.tag) || s.zoneTag;
    },

    editStyle(change) {
      const s = getState();
      const zone = s.selectedZone ? s.editor!.scene.zones.find((z) => z.id === s.selectedZone) : undefined;
      if (zone) {
        s.editor!.setStyle(change({ ...zone.style }), zone.id);
        edited();
      } else set({ zoneStyle: change({ ...s.zoneStyle }) });
    },

    setTag(tag) {
      const s = getState();
      if (s.selectedZone) {
        s.editor!.setTag(tag, s.selectedZone);
        edited();
      } else set({ zoneTag: tag, zoneStyle: { ...ZoneTag.defaultStyle(tag), tint: s.zoneStyle.tint } });
    },

    setShape(kind) {
      set({ forcedShape: kind });
      const s = getState();
      const zone = shownZone();
      if (!kind || !zone) return;
      const pts = Zone.outline(zone).map((p) => ({ x: p.x, y: p.z }));
      const geometry = ZoneBuilder.geometry(kind, pts, SmartGeometry.recognize(pts));
      if (!geometry) return;
      let z: Zone = { ...zone, geometry };
      if (s.snapping) {
        const frame = s.frame();
        const [snapped, hits] = ZoneSnapping.snap(z, frame.tokens.map((t) => t.point), frame.zones.filter((o) => o.id !== zone.id));
        z = snapped;
        show(hits);
      }
      s.editor!.setGeometry(z.geometry, z.id, s.currentPhase());
      edited();
    },

    enableTimeline() {
      resetPlayers();
      getState().editor!.setPhases([...RallyPhaseOrder]);
      edited();
    },

    disableTimeline() {
      resetPlayers();
      getState().editor!.setPhases(undefined);
      edited();
    },

    selectionHasKey(phase) {
      const s = getState();
      const scene = s.editor!.scene;
      if (s.selectedToken) return !!scene.tokens.find((t) => t.id === s.selectedToken)?.keys?.some((k) => k.phase === phase);
      if (s.selectedZone) return !!scene.zones.find((z) => z.id === s.selectedZone)?.keys?.some((k) => k.phase === phase);
      return false;
    },

    pinSelection() {
      const s = getState();
      const phase = s.currentPhase();
      if (!phase) return;
      const token = s.selectedToken ? s.frame().tokens.find((t) => t.id === s.selectedToken) : undefined;
      const zone = shownZone();
      if (token) s.editor!.moveToken(token.id, token.point, phase);
      else if (zone) s.editor!.setGeometry(zone.geometry, zone.id, phase);
      else return;
      edited();
    },

    clearSelectionKey() {
      const s = getState();
      const phase = s.currentPhase(), id = s.selectedToken ?? s.selectedZone;
      if (!phase || !id) return;
      s.editor!.clearKey(id, phase);
      edited();
    },

    toggleZoneVisibility() {
      const s = getState();
      const phase = s.currentPhase(), id = s.selectedZone;
      if (!phase || !id || sceneTimeline(s.editor!.scene).indexOf(phase) <= 0) return;
      const shown = s.frame().intensities.get(id) ?? 1;
      s.editor!.setIntensity(shown > 0.5 ? 0 : 1, id, phase);
      edited();
    },

    selectedPosture() {
      const s = getState();
      const t = s.selectedToken ? s.editor?.scene.tokens.find((tok) => tok.id === s.selectedToken) : undefined;
      if (!t) return undefined;
      const phase = s.currentPhase();
      if (phase && sceneTimeline(s.editor!.scene).indexOf(phase) > 0) return t.keys?.find((k) => k.phase === phase)?.posture;
      return t.posture;
    },

    setPosture(posture) {
      const s = getState();
      if (!s.selectedToken) return;
      s.editor!.setPosture(posture, s.selectedToken, s.currentPhase());
      edited();
    },

    currentContact() {
      const s = getState();
      const phase = s.currentPhase();
      return phase ? s.editor?.scene.contacts?.find((c) => c.phase === phase) : undefined;
    },

    currentContactIsLast() {
      const s = getState();
      const c = s.currentContact();
      const line = sceneTimeline(s.editor!.scene);
      if (!c) return false;
      const i = line.indexOf(c.phase);
      return !(s.editor!.scene.contacts ?? []).some((o) => line.indexOf(o.phase) > i);
    },

    setContact(kind) {
      const s = getState();
      const phase = s.currentPhase();
      if (!phase || !s.selectedToken) return;
      s.editor!.setContact({ phase, player: s.selectedToken, kind: kind ?? ContactKind.choices(phase)[0] }, phase);
      edited();
    },

    removeContact() {
      const s = getState();
      const phase = s.currentPhase();
      if (!phase) return;
      s.editor!.setContact(undefined, phase);
      edited();
    },

    aimLanding() {
      set({ aimingLanding: !getState().aimingLanding });
    },

    ballSummary() {
      const s = getState();
      const scene = s.editor?.scene;
      if (!scene || !sceneTimeline(scene).length) return undefined;
      return ballPlanOf(scene).segment(s.time)?.summary(PlayerBodies.netHeight);
    },

    tapFloor(p) {
      const s = getState();
      offerAlternative(undefined);
      if (!s.aimingLanding) return false;
      set({ aimingLanding: false });
      s.editor!.setBallLanding(p);
      edited();
      return true;
    },

    setLabel(id, label) {
      const l = label.trim();
      if (!l) return;
      getState().editor!.setLabel(l, id);
      edited();
    },

    toggleGazeTarget(id) {
      const s = getState();
      if (!s.gaze || id === s.gaze) return;
      const players = posedPlayers(s.frame());
      const targets = { ...(s.gazeTargets ?? Object.fromEntries(s.gazeTargetList(players))) };
      if (targets[id]) delete targets[id];
      else {
        const role = s.editor!.scene.tokens.find((t) => t.id === id)?.role ?? "";
        targets[id] = ["S", "S1", "S2"].includes(role) ? "head" : "hittingShoulder";
      }
      set({ gazeTargets: targets });
    },

    gazeTargetList(players) {
      const s = getState();
      const viewer = s.gaze ? players.find((p) => p.id === s.gaze) : undefined;
      if (!viewer) return [];
      if (s.gazeTargets) return Object.entries(s.gazeTargets).sort(([a], [b]) => a.localeCompare(b));
      return Gaze.defaultTargets(viewer, players);
    },

    updateStyle(pattern, tint) {
      getState().editStyle((st) => ({ ...st, ...(pattern ? { pattern } : {}), ...(tint ? { tint } : {}) }));
    },

    deleteSelection() {
      const s = getState();
      if (!s.selectedZone) return;
      s.editor!.deleteZone(s.selectedZone);
      set({ selectedZone: undefined });
      edited();
    },

    undo() {
      offerAlternative(undefined);
      resetPlayers();
      getState().editor!.undo();
      edited();
    },

    redo() {
      offerAlternative(undefined);
      resetPlayers();
      getState().editor!.redo();
      edited();
    },

    rename(title) {
      const t = title.trim();
      if (!t) return;
      getState().editor!.rename(t);
      edited();
    },

    enterPOV(id) {
      const s = getState();
      const who = id ?? s.selectedToken;
      if (!who) return;
      // In eye view the sight lines follow the viewer (Section 5.6); a new viewer starts from the read cues.
      set({ view3D: true, pov: who, gaze: who, gazeTargets: s.pov === who ? s.gazeTargets : undefined, selectedToken: who,
        povYaw: 0, povPitch: 0 });
    },

    exitPOV() {
      // The eye view turned the sight lines on; they go with it (Advanced turns them on again by hand).
      set({ pov: undefined, povYaw: 0, povPitch: 0, gaze: undefined, gazeTargets: undefined });
    },

    look(dx, dy) {
      const s = getState();
      if (!s.pov) return;
      const lim = (v: number, lo: number, hi: number) => Math.max((lo * Math.PI) / 180, Math.min((hi * Math.PI) / 180, v));
      set({ povYaw: lim(s.povYaw - dx, -70, 70), povPitch: lim(s.povPitch + dy, -50, 60) });
    },

    toggleGaze() {
      const s = getState();
      if (s.gaze && s.gaze === s.selectedToken) set({ gaze: undefined });
      else if (s.selectedToken) set({ gaze: s.selectedToken, gazeTargets: s.gaze === s.selectedToken ? s.gazeTargets : undefined });
    },
  };
});

/** All boards on the device, newest first. */
export async function listBoards(): Promise<BoardRecord[]> {
  return (await all<BoardRecord>("boards")).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function deleteBoard(id: string): Promise<void> {
  await remove("boards", id);
}
