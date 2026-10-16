// Port of Zones/TacticalScene.swift: SceneToken, TacticalScene (plain Codable data in Swift's JSON shape, with
// functions on the same-named objects) and SceneEditor (undo/redo). Swift's mutating scene methods (place, rotate,
// playOut) are pure functions returning a new scene. Dates are Foundation's: seconds since 2001-01-01 UTC.
import type { CourtPosition, FloorPoint, Side } from "../match/court";
import { CourtFrame } from "../match/court";
import type { InkStroke } from "../match/liveTypes";
import { defaultStature } from "../spatial/povAnalysis";
import type { Posture } from "../spatial/skeleton";
import { deepClone, deepEqual, minBy, newUUID, referenceDateNow, stripNulls } from "../spatial/swiftCompat";
import { defaultLanding, sceneBallPlan, type BallContact, type BallPlan } from "./ballPlan";
import { placeScene, placedScene, playOutScene, rotateScene, sceneLiveFrame, type AttackOption, type SceneSetup } from "./sceneAutopilot";
import {
  automaticPosture, sceneFrame, sceneTimeOf, sceneTimeline, TokenKey, ZoneKey, type RallyPhase, type SceneFrame,
} from "./sceneTimeline";
import { allPositions, formationOf, formationPositions, genericAnchors, positionLabel, type Template } from "./templateAccess";
import { Zone, ZoneSemantic, ZoneTag, type ZoneGeometry, type ZoneStyle } from "./zone";

/** A player token in a tactical scene, in world metres. */
export interface SceneToken {
  id: string;
  side: Side;
  label: string;
  role: string;
  point: FloorPoint;
  /** 3D avatar posture; undefined uses the default (ready on court, standing behind the end line). */
  posture?: Posture;
  /** Stature in metres for the 3D avatar; undefined uses a default by role. */
  stature?: number;
  /** Keyframes at later phase markers; `point` and `posture` are the first marker's (Section 3.3). */
  keys?: TokenKey[];
  /** Facing set by hand (radians from +Z toward +X); undefined faces automatically (the net, or the ball). */
  yaw?: number;
}

export const SceneToken = {
  create(init: {
    id?: string; side: Side; label: string; role: string; point: FloorPoint;
    posture?: Posture; stature?: number; keys?: TokenKey[]; yaw?: number;
  }): SceneToken {
    const t: SceneToken = { id: init.id ?? newUUID(), side: init.side, label: init.label, role: init.role, point: init.point };
    if (init.posture !== undefined) t.posture = init.posture;
    if (init.stature !== undefined) t.stature = init.stature;
    if (init.keys !== undefined) t.keys = init.keys;
    if (init.yaw !== undefined) t.yaw = init.yaw;
    return t;
  },

  effectivePosture(t: SceneToken): Posture {
    return t.posture ?? automaticPosture(t.point);
  },

  /** The explicit facing, else facing the net: home players face -Z, opponents +Z (radians from +Z toward +X). */
  facing(t: SceneToken): number {
    return t.yaw ?? (t.side === "home" ? Math.PI : 0);
  },

  /** Ready on court, standing behind the end line (the server). SceneTimeline.swift. */
  automaticPosture(p: FloorPoint): Posture {
    return automaticPosture(p);
  },

  /** Default stature by role when none is set (POVAnalysis.swift). */
  defaultStature(role: string): number {
    return defaultStature(role);
  },

  effectiveStature(t: SceneToken): number {
    return t.stature ?? defaultStature(t.role);
  },
};

/** A manual scene for the Analysis Canvas (Screen 8): tokens, zones and ink, all in world metres. */
export interface TacticalScene {
  id: string;
  title: string;
  /** Foundation reference-date seconds (Swift's default JSON encoding of `Date`). */
  createdAt: number;
  modifiedAt: number;
  tokens: SceneToken[];
  zones: Zone[];
  ink: InkStroke[];
  /** Phase markers of the scene's timeline in order (Section 3.5.7); undefined for a static scene. */
  phases?: RallyPhase[];
  /** Ball contacts at markers (Section 5.4); the physics flies the ball between them. */
  contacts?: BallContact[];
  /** Where the last flight lands; undefined uses the deep middle of the far half. */
  ballLanding?: FloorPoint;
  /** Height of the ball's centre where the last flight ends (a player's hands); undefined lands it on the floor. */
  ballLandingHeight?: number;
  /** The systems, rotations and server the players were placed from (undefined for a hand-made scene). */
  setup?: SceneSetup;
}

export const TacticalScene = {
  create(init: { id?: string; title: string; tokens?: SceneToken[]; zones?: Zone[]; ink?: InkStroke[] }): TacticalScene {
    const now = referenceDateNow();
    return { id: init.id ?? newUUID(), title: init.title, createdAt: now, modifiedAt: now, tokens: init.tokens ?? [],
      zones: init.zones ?? [], ink: init.ink ?? [] };
  },

  /** A new scene with both teams standing in template formations (home receiving, opponent serving by default). */
  fromFormations(init: {
    title: string; home: Template; homeRotation: number; homePhase: string; opponent: Template; opponentRotation: number;
    homeLabels?: Partial<Record<CourtPosition, string>>;
  }): TacticalScene {
    const tokens = (t: Template, rotation: number, phase: string, side: Side, labels: Partial<Record<CourtPosition, string>>): SceneToken[] => {
      const formation = formationOf(t, rotation, phase) ?? t.formations.find((f) => f.phase === phase) ?? t.formations[0];
      const anchors = formation ? formationPositions(formation) : genericAnchors(phase === "serve");
      const out: SceneToken[] = [];
      for (const pos of allPositions) {
        const p = anchors.get(pos);
        if (!p) continue;
        const role = formation?.players.find((pl) => pl.position === pos)?.role ?? positionLabel(pos);
        out.push(SceneToken.create({ side, label: labels[pos] ?? role, role, point: CourtFrame.world(p, side) }));
      }
      return out;
    };
    const opponentPhase = init.homePhase === "receive" ? "serve" : "receive";
    return TacticalScene.create({
      title: init.title,
      tokens: [
        ...tokens(init.home, init.homeRotation, init.homePhase, "home", init.homeLabels ?? {}),
        ...tokens(init.opponent, init.opponentRotation, opponentPhase, "opponent", {}),
      ],
    });
  },

  /** The scene as the iPad app's JSONEncoder writes it: a plain JSON value (JSON.stringify it for text). */
  encode(scene: TacticalScene): Record<string, unknown> {
    return deepClone(scene) as unknown as Record<string, unknown>;
  },

  /** A scene from JSON text or a parsed JSON value (null members read as absent, as Swift's decoder treats them). */
  decode(json: unknown): TacticalScene {
    return stripNulls<TacticalScene>(typeof json === "string" ? JSON.parse(json) : json);
  },

  equals(a: TacticalScene, b: TacticalScene): boolean {
    return deepEqual(a, b);
  },

  // SceneTimeline.swift

  /** The phase markers in use, in order; empty for a static scene. */
  timeline(scene: TacticalScene): RallyPhase[] {
    return sceneTimeline(scene);
  },
  /** Timeline position of a phase marker, or undefined when the scene does not use it. */
  time(scene: TacticalScene, phase: RallyPhase): number | undefined {
    return sceneTimeOf(scene, phase);
  },
  /** The scene at a timeline position in phase-index units (Swift `frame(at:)`). */
  frame(scene: TacticalScene, time: number): SceneFrame {
    return sceneFrame(scene, time);
  },

  // BallPlan.swift

  defaultLanding(side: Side): FloorPoint {
    return defaultLanding(side);
  },
  /** Solves the flights between the contacts (expensive: cache per scene value). */
  ballPlan(scene: TacticalScene, netHeight = 2.43): BallPlan {
    return sceneBallPlan(scene, netHeight);
  },

  // SceneAutopilot.swift (Swift's mutating methods return a new scene here)

  place(scene: TacticalScene, setup: SceneSetup): TacticalScene {
    return placeScene(scene, setup);
  },
  rotate(scene: TacticalScene, side: Side, forward = true): TacticalScene {
    return rotateScene(scene, side, forward);
  },
  placed(title: string, setup: SceneSetup): TacticalScene {
    return placedScene(title, setup);
  },
  playOut(scene: TacticalScene, attack?: AttackOption): TacticalScene {
    return playOutScene(scene, attack);
  },
  liveFrame(scene: TacticalScene, time: number, plan?: BallPlan): SceneFrame {
    return sceneLiveFrame(scene, time, plan);
  },
};

function setOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

/** Undoable editing of a scene: every edit pushes the previous scene, so undo and redo are exact. */
export class SceneEditor {
  private current: TacticalScene;
  private undoStack: TacticalScene[] = [];
  private redoStack: TacticalScene[] = [];
  static readonly historyLimit = 200;

  constructor(scene: TacticalScene) {
    this.current = scene;
  }

  /** The scene being edited (treat as read-only; every edit replaces it). */
  get scene(): TacticalScene {
    return this.current;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Applies a change to a copy of the scene (mutating it, or returning a replacement); no-ops are not recorded. */
  private edit(change: (s: TacticalScene) => TacticalScene | void): void {
    const copy = deepClone(this.current);
    const next = change(copy) ?? copy;
    if (deepEqual(next, this.current)) return;
    this.undoStack.push(this.current);
    if (this.undoStack.length > SceneEditor.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    next.modifiedAt = referenceDateNow();
    this.current = next;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.current);
    this.current = previous;
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.current);
    this.current = next;
  }

  addZone(zone: Zone): void {
    this.edit((s) => {
      s.zones.push(zone);
    });
  }

  replaceZone(zone: Zone): void {
    this.edit((s) => {
      const i = s.zones.findIndex((z) => z.id === zone.id);
      if (i >= 0) s.zones[i] = zone;
    });
  }

  deleteZone(id: string): void {
    this.edit((s) => {
      s.zones = s.zones.filter((z) => z.id !== id);
    });
  }

  setStyle(style: ZoneStyle, zoneID: string): void {
    this.edit((s) => {
      const i = s.zones.findIndex((z) => z.id === zoneID);
      if (i >= 0) s.zones[i].style = style;
    });
  }

  setTag(tag: ZoneTag, zoneID: string): void {
    this.edit((s) => {
      const i = s.zones.findIndex((z) => z.id === zoneID);
      if (i < 0) return;
      const tint = s.zones[i].style.tint;
      s.zones[i].semantic = ZoneSemantic.create(tag);
      s.zones[i].style = { ...ZoneTag.defaultStyle(tag), tint };
    });
  }

  /** True when `phase` is a later marker of the timeline, where edits write keyframes instead of base values. */
  private isKeyed(phase: RallyPhase | undefined): phase is RallyPhase {
    if (phase === undefined) return false;
    const i = sceneTimeline(this.current).indexOf(phase);
    return i > 0;
  }

  /**
   * Moves a token. Without a phase, or at the first marker, the base position moves; at a later marker that marker's
   * keyframe is set. Drags call this once at the end, so one drag is one undo step.
   */
  moveToken(id: string, point: FloorPoint, phase?: RallyPhase): void {
    if (!this.isKeyed(phase)) {
      this.edit((s) => {
        const i = s.tokens.findIndex((t) => t.id === id);
        if (i >= 0) s.tokens[i].point = point;
      });
      return;
    }
    this.edit((s) => {
      const i = s.tokens.findIndex((t) => t.id === id);
      if (i < 0) return;
      const keys = s.tokens[i].keys ?? [];
      const k = keys.findIndex((key) => key.phase === phase);
      if (k >= 0) keys[k].point = point;
      else keys.push(TokenKey.create(phase, point));
      s.tokens[i].keys = keys;
    });
  }

  /** Moves a zone by a world offset (at a later marker: keys the translated shape that marker shows). */
  moveZone(id: string, dx: number, dz: number, phase?: RallyPhase): void {
    if (!this.isKeyed(phase)) {
      this.edit((s) => {
        const i = s.zones.findIndex((z) => z.id === id);
        if (i >= 0) s.zones[i] = Zone.translated(s.zones[i], dx, dz);
      });
      return;
    }
    const shown = sceneFrame(this.current, sceneTimeOf(this.current, phase) ?? 0).zones.find((z) => z.id === id);
    if (!shown) return;
    this.setGeometry(Zone.translated(shown, dx, dz).geometry, id, phase);
  }

  /** Sets (or with undefined returns to automatic) a token's posture, at a marker as a keyframe. */
  setPosture(posture: Posture | undefined, id: string, phase?: RallyPhase): void {
    if (!this.isKeyed(phase)) {
      this.edit((s) => {
        const i = s.tokens.findIndex((t) => t.id === id);
        if (i >= 0) setOptional(s.tokens[i], "posture", posture);
      });
      return;
    }
    const t = sceneTimeOf(this.current, phase) ?? 0;
    const shown = sceneFrame(this.current, t).tokens.find((tok) => tok.id === id)?.point;
    this.edit((s) => {
      const i = s.tokens.findIndex((tok) => tok.id === id);
      if (i < 0 || !shown) return;
      const keys = s.tokens[i].keys ?? [];
      const k = keys.findIndex((key) => key.phase === phase);
      if (k >= 0) setOptional(keys[k], "posture", posture);
      else keys.push(TokenKey.create(phase, shown, posture));
      s.tokens[i].keys = keys;
    });
  }

  // Timeline (Section 3.5.7)

  /** Turns the timeline on with these markers, or off with undefined (keyframes are kept and return with them). */
  setPhases(phases: RallyPhase[] | undefined): void {
    this.edit((s) => setOptional(s, "phases", phases));
  }

  /** Sets a zone's geometry at a phase marker (base geometry at the first marker or in a static scene). */
  setGeometry(geometry: ZoneGeometry, id: string, phase?: RallyPhase): void {
    this.edit((s) => {
      const i = s.zones.findIndex((z) => z.id === id);
      if (i < 0) return;
      const p = phase === undefined ? -1 : sceneTimeline(s).indexOf(phase);
      if (phase === undefined || p <= 0) {
        s.zones[i].geometry = geometry;
        return;
      }
      const shownIntensity = sceneFrame(s, p).intensities.get(id) ?? 1;
      const keys = s.zones[i].keys ?? [];
      const k = keys.findIndex((key) => key.phase === phase);
      if (k >= 0) keys[k].geometry = geometry;
      else keys.push(ZoneKey.create(phase, geometry, shownIntensity));
      s.zones[i].keys = keys;
    });
  }

  /** Style intensity of a zone at a later marker (0 hides it there). */
  setIntensity(intensity: number, id: string, phase: RallyPhase): void {
    if (!this.isKeyed(phase)) return;
    const p = sceneTimeOf(this.current, phase);
    if (p === undefined) return;
    const shown = sceneFrame(this.current, p).zones.find((z) => z.id === id)?.geometry;
    this.edit((s) => {
      const i = s.zones.findIndex((z) => z.id === id);
      if (i < 0 || !shown) return;
      const keys = s.zones[i].keys ?? [];
      const k = keys.findIndex((key) => key.phase === phase);
      if (k >= 0) keys[k].intensity = intensity;
      else keys.push(ZoneKey.create(phase, shown, intensity));
      s.zones[i].keys = keys;
    });
  }

  /** Sets (or with undefined removes) the ball contact at a marker; one contact per marker. */
  setContact(contact: BallContact | undefined, phase: RallyPhase): void {
    this.edit((s) => {
      const list = (s.contacts ?? []).filter((c) => c.phase !== phase);
      if (contact) list.push(contact);
      setOptional(s, "contacts", list.length === 0 ? undefined : list);
    });
  }

  setBallLanding(p: FloorPoint | undefined): void {
    this.edit((s) => {
      setOptional(s, "ballLanding", p);
      delete s.ballLandingHeight;
    });
  }

  /** Removes a token's or zone's keyframe at a marker, so it interpolates through that marker again. */
  clearKey(id: string, phase: RallyPhase): void {
    this.edit((s) => {
      const t = s.tokens.find((tok) => tok.id === id);
      if (t?.keys) {
        t.keys = t.keys.filter((k) => k.phase !== phase);
        if (t.keys.length === 0) delete t.keys;
      }
      const z = s.zones.find((zone) => zone.id === id);
      if (z?.keys) {
        z.keys = z.keys.filter((k) => k.phase !== phase);
        if (z.keys.length === 0) delete z.keys;
      }
    });
  }

  // Easy placement

  /** Places both teams from a setup (systems, rotations, who serves); one undo step. */
  place(setup: SceneSetup): void {
    this.edit((s) => placeScene(s, setup));
  }

  /** The next (or previous) rotation for a side, placed. */
  rotate(side: Side, forward = true): void {
    this.edit((s) => rotateScene(s, side, forward));
  }

  /** Plays the rally out from the placed formations (serve to defence, with the ball). */
  playOut(attack?: AttackOption): void {
    this.edit((s) => playOutScene(s, attack));
  }

  /** Sets (or with undefined returns to automatic) a player's facing. */
  setYaw(yaw: number | undefined, id: string): void {
    this.edit((s) => {
      const t = s.tokens.find((tok) => tok.id === id);
      if (t) setOptional(t, "yaw", yaw);
    });
  }

  addInk(stroke: InkStroke): void {
    this.edit((s) => {
      s.ink.push(stroke);
    });
  }

  clearInk(): void {
    this.edit((s) => {
      s.ink = [];
    });
  }

  rename(title: string): void {
    this.edit((s) => {
      s.title = title;
    });
  }

  /** The topmost zone under a point (the last drawn wins), for selection. Swift `zone(at:tolerance:)`. */
  zoneAt(p: FloorPoint, tolerance = 0.15): Zone | undefined {
    const zones = this.current.zones;
    for (let i = zones.length - 1; i >= 0; i--) if (Zone.distance(zones[i], p) <= tolerance) return zones[i];
    return undefined;
  }

  /** Swift `token(near:within:)`. */
  tokenNear(p: FloorPoint, within = 0.6): SceneToken | undefined {
    const near = this.current.tokens
      .map((t): [SceneToken, number] => [t, Math.hypot(t.point.x - p.x, t.point.z - p.z)])
      .filter((e) => e[1] <= within);
    return minBy(near, (e) => e[1])?.[0];
  }
}

