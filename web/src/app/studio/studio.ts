import { create } from "zustand";
import type { FloorPoint, Side } from "../../core/match/court";
import { InkStroke } from "../../core/match/liveTypes";
import { PlayerBodies } from "../../core/spatial";
import {
  PlacementAssist, SceneEditor, SceneSetup, TacticalScene, ZoneBuilder, ZoneStyle, sceneTimeline, templateRotations,
  type AttackOption, type BallPlan, type RallyPhase, type SceneFrame, type Zone, type ZonePattern, type ZoneTint,
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

/** Seconds per phase interval during playback (as on the iPad). */
const secondsPerPhase = 1.1;

let planCache: { scene: TacticalScene; net: number; plan: BallPlan } | undefined;

/** The ball's flights for a scene (solving them is expensive, so one plan is kept per scene value). */
export function ballPlanOf(scene: TacticalScene): BallPlan {
  const net = PlayerBodies.netHeight;
  if (planCache && planCache.scene === scene && planCache.net === net) return planCache.plan;
  const plan = TacticalScene.ballPlan(scene, net);
  planCache = { scene, net, plan };
  return plan;
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
  /** Style for the next zone drawn. */
  zoneStyle: ZoneStyle;
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
  set(change: Partial<Pick<StudioState, "tool" | "view3D" | "flipped">>): void;
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

  const tweenTo = (target: number, duration: number, playback = false) => {
    stopTween();
    const start = getState().time;
    const begin = performance.now();
    const step = (now: number) => {
      const f = duration > 0 ? Math.min(1, (now - begin) / (duration * 1000)) : 1;
      set({ time: start + (target - start) * f });
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
    set({ time: 0, playing: false, pov: undefined, gaze: undefined });
  };

  return {
    version: 0,
    tool: "move",
    time: 0,
    playing: false,
    view3D: false,
    povYaw: 0,
    povPitch: 0,
    zoneStyle: { ...ZoneStyle.create(), pattern: "diagonal", tint: "pink" },
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
      tweenTo(end, (end - getState().time) * secondsPerPhase, true);
    },

    goTo(phase) {
      const s = getState();
      const target = TacticalScene.time(s.editor!.scene, phase);
      if (target === undefined) return;
      set({ playing: false });
      tweenTo(target, 0.45 * Math.sqrt(Math.max(1, Math.abs(target - s.time))));
    },

    select(token, zone) {
      set({ selectedToken: token, selectedZone: zone });
    },

    moveToken(id, p) {
      const s = getState();
      const scene = s.editor!.scene;
      const token = scene.tokens.find((t) => t.id === id);
      if (!token) return;
      const others = s.frame().tokens;
      const spots = PlacementAssist.spots(token.side, scene.setup);
      const { point } = PlacementAssist.adjust(p, id, token.side, others, spots);
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
      const scene = s.editor!.scene;
      const built = ZoneBuilder.build(stroke, {
        style: s.zoneStyle, tokens: s.frame().tokens.map((t) => t.point), otherZones: scene.zones,
      });
      if (!built) return;
      s.editor!.addZone(built.zone);
      edited();
      set({ selectedZone: built.zone.id, selectedToken: undefined });
    },

    updateStyle(pattern, tint) {
      const s = getState();
      const next: ZoneStyle = { ...s.zoneStyle, ...(pattern ? { pattern } : {}), ...(tint ? { tint } : {}) };
      set({ zoneStyle: next });
      const zone: Zone | undefined = s.selectedZone ? s.editor!.scene.zones.find((z) => z.id === s.selectedZone) : undefined;
      if (zone) {
        s.editor!.setStyle({ ...zone.style, ...(pattern ? { pattern } : {}), ...(tint ? { tint } : {}) }, zone.id);
        edited();
      }
    },

    deleteSelection() {
      const s = getState();
      if (!s.selectedZone) return;
      s.editor!.deleteZone(s.selectedZone);
      set({ selectedZone: undefined });
      edited();
    },

    undo() {
      resetPlayers();
      getState().editor!.undo();
      edited();
    },

    redo() {
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
      set({ view3D: true, pov: who, gaze: s.gaze ? who : undefined, selectedToken: who, povYaw: 0, povPitch: 0 });
    },

    exitPOV() {
      set({ pov: undefined, povYaw: 0, povPitch: 0 });
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
      else if (s.selectedToken) set({ gaze: s.selectedToken });
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
