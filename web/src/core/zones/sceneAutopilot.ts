// Port of Zones/SceneAutopilot.swift: easy placement from a setup, the rally autopilot, automatic facing and drop
// help. Swift's mutating TacticalScene methods are pure functions here that return a new scene; the RotationTemplate
// extension (rotations, next/previous rotation, placement, base spots, route targets, setter spot) is free functions.
import type { CourtPosition, FloorPoint, LocalPoint, Side } from "../match/court";
import { CourtFrame } from "../match/court";
import type { V3 } from "../spatial/math3d";
import type { Posture } from "../spatial/skeleton";
import { postureReach } from "../spatial/bodySeparation";
import { deepClone, minBy } from "../spatial/swiftCompat";
import type { BallContact, BallPlan } from "./ballPlan";
import { automaticPosture, RallyPhase, sceneFrame, sceneTimeline, TokenKey, type SceneFrame } from "./sceneTimeline";
import { sceneMotion } from "./sceneMotion";
import { SceneToken, TacticalScene } from "./tacticalScene";
import {
  allPositions, courtPosition, distance, formationOf, genericAnchors, isFrontRow, loadTemplate, localPoint, positionLabel,
  type Template,
} from "./templateAccess";

/** The attack the autopilot plays when it plays out a rally. */
export type AttackOption = "left" | "middle" | "right" | "back";

export const AttackOption = {
  allCases: ["left", "middle", "right", "back"] as readonly AttackOption[],

  title(a: AttackOption): string {
    switch (a) {
      case "left": return "Left";
      case "middle": return "Middle";
      case "right": return "Right";
      case "back": return "Back row";
    }
  },

  /** Template routes that hit this attack, in order of preference. */
  routes(a: AttackOption): string[] {
    switch (a) {
      case "left": return ["left"];
      case "middle": return ["quick"];
      case "right": return ["right", "dball"];
      case "back": return ["pipe", "dball"];
    }
  },

  /** Where the attacker meets the ball, in the attacking team's frame (l from its left sideline, d from the net). */
  contactSpot(a: AttackOption, setter: LocalPoint): LocalPoint {
    switch (a) {
      case "left": return { l: 1.0, d: 1.0 };
      case "middle": return { l: Math.max(1.5, setter.l - 1.3), d: 0.9 };
      case "right": return { l: 8.0, d: 1.0 };
      case "back": return { l: 4.5, d: 3.4 };
    }
  },
};

/** The default system (Swift `TeamSystem.fiveOneOutside.rawValue`). */
const defaultSystem = "5-1-outside-follows-setter";

/** What the coach picks once: both systems, both rotations and who serves. Everything else is placed from it. */
export interface SceneSetup {
  homeSystem: string;
  homeRotation: number;
  opponentSystem: string;
  opponentRotation: number;
  homeServes: boolean;
  attack: AttackOption;
  /** Labels the coach gave players, keyed "home.OH1", kept across rotations and libero swaps. */
  labels: Record<string, string>;
}

export const SceneSetup = {
  create(init: Partial<SceneSetup> = {}): SceneSetup {
    return {
      homeSystem: init.homeSystem ?? defaultSystem,
      homeRotation: init.homeRotation ?? 1,
      opponentSystem: init.opponentSystem ?? defaultSystem,
      opponentRotation: init.opponentRotation ?? 1,
      homeServes: init.homeServes ?? false,
      attack: init.attack ?? "left",
      labels: init.labels ?? {},
    };
  },
  system(s: SceneSetup, side: Side): string {
    return side === "home" ? s.homeSystem : s.opponentSystem;
  },
  rotation(s: SceneSetup, side: Side): number {
    return side === "home" ? s.homeRotation : s.opponentRotation;
  },
  serves(s: SceneSetup, side: Side): boolean {
    return s.homeServes === (side === "home");
  },
  /** Swift `setRotation(_:for:)` on a copy. */
  withRotation(s: SceneSetup, r: number, side: Side): SceneSetup {
    return side === "home" ? { ...s, homeRotation: r } : { ...s, opponentRotation: r };
  },
  labelKey(side: Side, role: string): string {
    return `${side}.${role}`;
  },
};

/** One player of a team's formation, as the autopilot reads it from a template. */
export interface PlacedPlayer {
  role: string;
  position: CourtPosition;
  point: LocalPoint;
  route?: string;
  passes: boolean;
  switchTo?: LocalPoint;
}

// RotationTemplate extension

/** Rotations the template has formations for. */
export function templateRotations(t: Template): number[] {
  return [...new Set(t.formations.map((f) => f.rotation))].sort((a, b) => a - b);
}

function step(t: Template, r: number, delta: number): number {
  const available = new Set(templateRotations(t));
  if (!(available.size > 1 && r >= 1 && r <= 6)) return r;
  let n = r;
  for (let i = 0; i < 6; i++) {
    n = ((((n - 1 + delta) % 6) + 6) % 6) + 1;
    if (available.has(n)) return n;
  }
  return r;
}

/**
 * The rotation after a side-out: the setter moves from P1 to P6, so R1 becomes R6, then R5 (the app names a rotation
 * by the setter's position). Rotations the template lacks are skipped.
 */
export function nextRotation(t: Template, r: number): number {
  return step(t, r, -1);
}

export function previousRotation(t: Template, r: number): number {
  return step(t, r, 1);
}

/** The team's players for a phase. Without a serve formation (4-2, youth W) the receive players stand on generic serving anchors. */
export function placement(t: Template, rotation: number, serving: boolean): PlacedPlayer[] {
  const phase = serving ? "serve" : "receive";
  const f = formationOf(t, rotation, phase);
  const placed = (p: { role: string; position: CourtPosition; point: LocalPoint; route?: string | null; passes: boolean; switchTo?: LocalPoint }): PlacedPlayer => {
    const out: PlacedPlayer = { role: p.role, position: p.position, point: p.point, passes: p.passes };
    if (p.route != null) out.route = p.route;
    if (p.switchTo !== undefined) out.switchTo = p.switchTo;
    return out;
  };
  if (f) {
    const out: PlacedPlayer[] = [];
    for (const p of f.players) {
      const pos = courtPosition(p.position);
      if (pos === undefined) continue;
      out.push(placed({ role: p.role, position: pos, point: localPoint(p.anchor), route: p.route, passes: p.passes,
        switchTo: p.switchTo != null ? localPoint(p.switchTo) : undefined }));
    }
    return out;
  }
  const source = formationOf(t, rotation, "receive") ?? t.formations.find((fo) => fo.phase === "receive") ?? t.formations[0];
  const anchors = genericAnchors(serving);
  if (!source) {
    return allPositions.map((pos) => placed({ role: positionLabel(pos), position: pos, point: anchors.get(pos)!, passes: true }));
  }
  const out: PlacedPlayer[] = [];
  for (const p of source.players) {
    const pos = courtPosition(p.position);
    if (pos === undefined) continue;
    out.push(placed({ role: p.role, position: pos, point: serving ? anchors.get(pos)! : localPoint(p.anchor),
      route: serving ? undefined : p.route, passes: p.passes }));
  }
  return out;
}

export const defaultBaseSlots: Readonly<Record<string, number[]>> = {
  LF: [1.0, 0.7], MF: [4.5, 0.7], RF: [8.0, 0.7], LB: [1.2, 6.3], MBK: [4.5, 8.0], RB: [7.8, 6.3],
};

export const defaultRouteTargets: Readonly<Record<string, number[]>> = {
  left: [-0.3, 3.8], right: [9.3, 3.8], quick: [4.6, 3.0], pipe: [4.5, 6.6], dball: [7.8, 6.6], target: [6.0, 0.7],
};

const slotKeys: Record<CourtPosition, string> = { 4: "LF", 3: "MF", 2: "RF", 5: "LB", 6: "MBK", 1: "RB" };

/**
 * Where a player goes in base defence: the serve formation's switch for that role, else the slot of the court position
 * (P4 left front ... P1 right back).
 */
export function baseSpot(t: Template, role: string, position: CourtPosition, rotation: number): LocalPoint {
  const serve = formationOf(t, rotation, "serve");
  const partners = new Set(t.libero?.replaces ?? []);
  // The libero takes over the back-row partner on its own court position, never the partner at the net.
  const match = serve?.players.find((p) => p.role === role)
    ?? (role === "L"
      ? serve?.players.find((p) => partners.has(p.role) && courtPosition(p.position) === position)
      : serve?.players.find((p) => partners.has(role) && p.role === "L"));
  const s = match?.switchTo;
  if (s != null && s.length === 2) return localPoint(s);
  const slots = t.baseSlots ?? defaultBaseSlots;
  const key = slotKeys[position];
  return localPoint(slots[key] ?? defaultBaseSlots[key]);
}

export function routeTarget(t: Template, route: string): LocalPoint | undefined {
  const pair = t.routeTargets[route] ?? defaultRouteTargets[route];
  return pair ? localPoint(pair) : undefined;
}

export function setterSpot(t: Template): LocalPoint {
  return t.setterTarget.length === 2 ? localPoint(t.setterTarget) : { l: 6.0, d: 0.7 };
}

/** "C (setter)" reads "C" on a token. */
function shortLabel(role: string): string {
  return role.split(" ").find((part) => part.length > 0) ?? role;
}

const sides: readonly Side[] = ["home", "opponent"];
const other = (side: Side): Side => (side === "home" ? "opponent" : "home");

/**
 * Places both teams from a setup: the serving team in its serve formation (server behind the end line), the receiving
 * team in its receive formation. Players keep their identity and label by role; the libero comes and goes as the
 * template says. Any rally on the timeline is cleared; zones and ink stay. Swift `TacticalScene.place(_:)`.
 */
export function placeScene(scene: TacticalScene, setup0: SceneSetup): TacticalScene {
  const setup: SceneSetup = { ...setup0, labels: { ...setup0.labels } };
  for (const t of scene.tokens) setup.labels[SceneSetup.labelKey(t.side, t.role)] = t.label;
  const placed: SceneToken[] = [];
  for (const side of sides) {
    const t = loadTemplate(SceneSetup.system(setup, side));
    const players = t ? placement(t, SceneSetup.rotation(setup, side), SceneSetup.serves(setup, side)) : [];
    const pool = scene.tokens.filter((tok) => tok.side === side);
    for (const p of players) {
      let token: SceneToken;
      const i = pool.findIndex((tok) => tok.role === p.role);
      if (i >= 0) {
        token = deepClone(pool[i]);
        pool.splice(i, 1);
      } else {
        token = SceneToken.create({ side, label: setup.labels[SceneSetup.labelKey(side, p.role)] ?? shortLabel(p.role), role: p.role,
          point: { x: 0, z: 0 } });
      }
      token.point = CourtFrame.world(p.point, side);
      delete token.posture;
      delete token.keys;
      delete token.yaw;
      placed.push(token);
    }
  }
  const out: TacticalScene = { ...scene, tokens: placed, setup };
  delete out.phases;
  delete out.contacts;
  delete out.ballLanding;
  delete out.ballLandingHeight;
  return out;
}

/** The next (or previous) rotation for a side (after a side-out), placed. Swift `TacticalScene.rotate(_:forward:)`. */
export function rotateScene(scene: TacticalScene, side: Side, forward = true): TacticalScene {
  const s = scene.setup ?? SceneSetup.create();
  const t = loadTemplate(SceneSetup.system(s, side));
  if (!t) return scene;
  const r = SceneSetup.rotation(s, side);
  return placeScene(scene, SceneSetup.withRotation(s, forward ? nextRotation(t, r) : previousRotation(t, r), side));
}

/** A new scene with both teams placed from a setup. Swift `TacticalScene.placed(title:setup:)`. */
export function placedScene(title: string, setup: SceneSetup): TacticalScene {
  return placeScene(TacticalScene.create({ title }), setup);
}

function mix(a: LocalPoint, b: LocalPoint, t: number): LocalPoint {
  return { l: a.l + (b.l - a.l) * t, d: a.d + (b.d - a.d) * t };
}

function clampSide(p: FloorPoint, side: Side): FloorPoint {
  return { x: Math.min(6, Math.max(-6, p.x)), z: side === "home" ? Math.min(11, Math.max(0.3, p.z)) : Math.max(-11, Math.min(-0.3, p.z)) };
}

/** A cover spot about 1.8 m behind the hitter, on the side the coverer comes from. */
function coverSpot(spot: LocalPoint, p: LocalPoint): LocalPoint {
  const dl = p.l - spot.l, dd = Math.max(0.6, p.d - spot.d);
  const n = Math.max(1e-6, Math.sqrt(dl * dl + dd * dd));
  return { l: Math.min(8.8, Math.max(0.2, spot.l + (dl / n) * 1.8)), d: Math.max(1.6, spot.d + (dd / n) * 1.8) };
}

/**
 * Plays the rally out from the placed formations: serve, pass, set, the chosen attack, block and cover, the dig, and
 * both teams moving between, with postures and the ball's contacts. Everything it writes is ordinary keyframes and
 * contacts, so the coach can change any of it afterwards. Swift `TacticalScene.playOut(_:)`.
 */
export function playOutScene(scene0: TacticalScene, attack?: AttackOption): TacticalScene {
  let setup = scene0.setup ?? SceneSetup.create();
  if (attack !== undefined) setup = { ...setup, attack };
  // As in Swift, the placed scene's setup (with the token labels merged in) is replaced by this one at the end.
  const s = placeScene(scene0, setup);
  const serving: Side = setup.homeServes ? "home" : "opponent";
  const receiving = other(serving);
  const st = loadTemplate(SceneSetup.system(setup, serving)), rt = loadTemplate(SceneSetup.system(setup, receiving));
  if (!st || !rt) return s;
  const sPlayers = placement(st, SceneSetup.rotation(setup, serving), true);
  const rPlayers = placement(rt, SceneSetup.rotation(setup, receiving), false);
  const tokens = s.tokens;
  const token = (side: Side, role: string): number | undefined => {
    const i = tokens.findIndex((t) => t.side === side && t.role === role);
    return i >= 0 ? i : undefined;
  };
  const key = (i: number, phase: RallyPhase, p: LocalPoint, posture: Posture): void => {
    const side = tokens[i].side;
    const keys = (tokens[i].keys ?? []).filter((k) => k.phase !== phase);
    keys.push(TokenKey.create(phase, CourtFrame.world(p, side), posture));
    tokens[i].keys = keys;
  };

  s.phases = [...RallyPhase.allCases];
  const newContacts: BallContact[] = [];

  // Receiving team: pass, set, attack, cover, then back to base.
  const setterTarget = setterSpot(rt);
  const setter = rPlayers.find((p) => p.route === "target")
    ?? rPlayers.find((p) => p.role.toLowerCase().includes("setter"))
    ?? minBy(rPlayers, (p) => distance(p.point, setterTarget));
  const passers = rPlayers.filter((p) => p.passes && p.role !== setter?.role);
  const passer = minBy(passers, (p) => Math.abs(p.point.l - 4.5) + 0.3 * Math.abs(p.point.d - 5))
    ?? rPlayers.find((p) => p.role !== setter?.role);
  let attacker: PlacedPlayer | undefined;
  for (const r of AttackOption.routes(setup.attack)) {
    attacker = rPlayers.find((p) => p.route === r);
    if (attacker) break;
  }
  attacker = attacker ?? rPlayers.find((p) => p.route === "left") ?? rPlayers.find((p) => p.route !== undefined && p.route !== "target");
  const attackRoute = attacker?.route ?? "left";
  const effectiveAttack: AttackOption = attackRoute === "quick" ? "middle" : attackRoute === "pipe" ? "back"
    : attackRoute === "dball" ? "back" : attackRoute === "right" ? "right" : "left";
  const spot = effectiveAttack === "back" && attackRoute === "dball" ? { l: 7.0, d: 3.4 } : AttackOption.contactSpot(effectiveAttack, setterTarget);

  for (const p of rPlayers) {
    const i = token(receiving, p.role);
    if (i === undefined) continue;
    const start = p.point;
    const base = baseSpot(rt, p.role, p.position, SceneSetup.rotation(setup, receiving));
    if (p.role === setter?.role) {
      key(i, "receive", setterTarget, "ready");
      key(i, "set", setterTarget, "set");
      key(i, "attack", { l: setterTarget.l, d: setterTarget.d + 0.6 }, "cover");
      key(i, "cover", { l: setterTarget.l, d: setterTarget.d + 0.9 }, "cover");
      key(i, "defence", base, "ready");
      continue;
    }
    const isPasser = p.role === passer?.role;
    const approach = p.route !== undefined ? routeTarget(rt, p.route) : undefined;
    key(i, "receive", start, isPasser ? "pass" : p.passes ? "ready" : "readyHigh");
    if (p.role === attacker?.role) {
      const runFrom = approach ?? { l: spot.l, d: spot.d + 3 };
      key(i, "set", runFrom, "approach");
      key(i, "attack", spot, "attack");
      key(i, "cover", { l: spot.l, d: spot.d + 0.3 }, "landing");
    } else if (approach) {
      // Decoys run their routes too; their approach stops short of the net.
      key(i, "set", approach, "approach");
      key(i, "attack", mix(approach, { l: approach.l, d: 1.2 }, 0.6), "readyHigh");
      key(i, "cover", coverSpot(spot, approach), "cover");
    } else {
      // Back-row players without a route cover the hitter.
      const cover = coverSpot(spot, start);
      key(i, "set", mix(start, cover, 0.5), "ready");
      key(i, "attack", cover, "cover");
      key(i, "cover", cover, "cover");
    }
    key(i, "defence", base, "ready");
  }

  // Serving team: serve, switch to base, block, defend, dig.
  const server = sPlayers.find((p) => p.position === 1);
  const blockLine = 9 - spot.l; // the attack spot seen from across the net
  const frontRow = sPlayers.filter((p) => isFrontRow(p.position));
  const backRow = sPlayers.filter((p) => !isFrontRow(p.position));
  const baseOf = (p: PlacedPlayer): LocalPoint => p.switchTo ?? baseSpot(st, p.role, p.position, SceneSetup.rotation(setup, serving));
  const byDistance = [...frontRow].sort((a, b) => Math.abs(baseOf(a).l - blockLine) - Math.abs(baseOf(b).l - blockLine));
  const blockers = byDistance.slice(0, effectiveAttack === "back" ? 1 : 2).sort((a, b) => baseOf(a).l - baseOf(b).l);
  // The attack goes cross-court, deep: across the net it lands on the far side from where it was hit.
  const target = { l: Math.min(7.6, Math.max(1.4, spot.l)), d: effectiveAttack === "back" ? 7.8 : 6.2 };
  const digger = minBy(backRow, (p) => distance(baseOf(p), target));
  const sSetterTarget = setterSpot(st);
  const sSetter = sPlayers.find((p) => ["S", "S1"].includes(p.role) || p.role.toLowerCase().includes("setter"));

  for (const p of sPlayers) {
    const i = token(serving, p.role);
    if (i === undefined) continue;
    const base = baseOf(p);
    const isServer = p.role === server?.role;
    if (isServer) tokens[i].posture = "floatServe";
    key(i, "receive", base, isFrontRow(p.position) ? "blockReady" : "ready");
    const b = blockers.findIndex((bl) => bl.role === p.role);
    if (b >= 0) {
      // Two blockers close side by side on the hitter, in the order they come from.
      const l = Math.min(8.6, Math.max(0.4, blockLine + (blockers.length === 1 ? 0 : b === 0 ? -0.45 : 0.45)));
      key(i, "set", { l: (base.l + l) / 2, d: 0.5 }, "blockReady");
      key(i, "attack", { l, d: 0.35 }, "block");
      key(i, "cover", { l, d: 0.45 }, "blockLanding");
      key(i, "defence", { l, d: 2.6 }, "ready");
    } else if (isFrontRow(p.position)) {
      // The front-row player not blocking drops off the net for the tip.
      const off = { l: Math.min(8, Math.max(1, base.l)), d: 3.2 };
      key(i, "set", { l: base.l, d: 1.0 }, "blockReady");
      key(i, "attack", off, "lowDefence");
      key(i, "cover", off, "lowDefence");
      key(i, "defence", { l: off.l, d: 3.5 }, "ready");
    } else if (p.role === digger?.role) {
      key(i, "set", base, "ready");
      key(i, "attack", mix(base, target, 0.7), "lowDefence");
      key(i, "cover", target, "dig");
      key(i, "defence", target, "ready");
    } else {
      key(i, "set", base, "ready");
      key(i, "attack", base, "lowDefence");
      key(i, "cover", base, "lowDefence");
      key(i, "defence", base, "ready");
    }
    if (p.role === sSetter?.role && p.role !== digger?.role) key(i, "defence", sSetterTarget, "set");
  }

  const addContact = (phase: RallyPhase, side: Side, who: PlacedPlayer | undefined, kind: BallContact["kind"]): void => {
    if (!who) return;
    const i = token(side, who.role);
    if (i !== undefined) newContacts.push({ phase, player: tokens[i].id, kind });
  };
  addContact("serve", serving, server, "floatServe");
  addContact("receive", receiving, passer, "pass");
  addContact("set", receiving, setter, effectiveAttack === "middle" ? "quickSet" : "highSet");
  addContact("attack", receiving, attacker, "attack");
  addContact("cover", serving, digger, "dig");
  if (newContacts.length > 0) s.contacts = newContacts;
  else delete s.contacts;
  // The dig rises into the hands of the serving team's setter at their target.
  s.ballLanding = CourtFrame.world({ l: sSetterTarget.l, d: sSetterTarget.d + 0.15 }, serving);
  const setterToken = sSetter ? token(serving, sSetter.role) : undefined;
  s.ballLandingHeight = (setterToken !== undefined ? SceneToken.effectiveStature(tokens[setterToken]) : 1.9) + 0.15;
  s.setup = setup;
  separateKeys(s);
  return s;
}

/**
 * Keeps teammates apart at every marker the autopilot wrote: far enough that their bodies cannot touch in the postures
 * they hold there (the sum of how far each reaches out; 0.8 to 1.6 m: blockers side by side stand close, covering
 * players in a wide stance far apart). Spots taken from the template formations (the receiving team's pass formation)
 * and whoever plays the ball there stay put; the rest are pushed apart within their own half and off the net.
 */
function separateKeys(s: TacticalScene): void {
  const tokens = s.tokens;
  const receiving: Side = s.setup?.homeServes ? "opponent" : "home";
  for (const phase of sceneTimeline(s).slice(1)) {
    const player = s.contacts?.find((c) => c.phase === phase)?.player;
    for (const side of sides) {
      const idx = tokens.map((_, i) => i).filter((i) => tokens[i].side === side && tokens[i].keys?.some((k) => k.phase === phase) === true);
      const key = (i: number) => tokens[i].keys!.find((k) => k.phase === phase)!;
      const fixed = (i: number) => tokens[i].id === player
        || (phase === "receive" && side === receiving && Math.hypot(key(i).point.x - tokens[i].point.x, key(i).point.z - tokens[i].point.z) < 1e-9);
      spreadApart(idx.map((i) => keySpot(key(i), fixed(i))), side);
    }
  }
}

interface Spot {
  point: FloorPoint;
  readonly posture?: Posture;
  readonly fixed: boolean;
}

/** A token's or a key's spot, written back when it moves. */
function keySpot(k: { point: FloorPoint; posture?: Posture }, fixed: boolean): Spot {
  return { get point() { return k.point; }, set point(p: FloorPoint) { k.point = p; }, posture: k.posture, fixed };
}

/**
 * Pushes one team's spots at a marker apart, far enough that their bodies cannot touch in the postures they hold there
 * (the sum of how far each reaches out, 0.8 to 1.6 m); fixed spots stay, the rest stay within their own half and off
 * the net. Exactly on top of each other: apart along the net.
 */
function spreadApart(spots: Spot[], side: Side): void {
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let n = 0; n < spots.length; n++) {
      const a = spots[n];
      for (const b of spots.slice(n + 1)) {
        const gap = Math.min(1.6, Math.max(0.8, postureReach(a.posture ?? automaticPosture(a.point))
          + postureReach(b.posture ?? automaticPosture(b.point))));
        const pa = a.point, pb = b.point;
        const dx = pb.x - pa.x, dz = pb.z - pa.z, d = Math.hypot(dx, dz);
        if (!(d < gap - 1e-6) || (a.fixed && b.fixed)) continue;
        moved = true;
        const [ux, uz] = d > 1e-6 ? [dx / d, dz / d] : [1.0, 0.0];
        const push = gap - d;
        const wa = a.fixed ? 0.0 : b.fixed ? 1.0 : 0.5;
        a.point = clampSide({ x: pa.x - ux * push * wa, z: pa.z - uz * push * wa }, side);
        b.point = clampSide({ x: pb.x + ux * push * (1 - wa), z: pb.z + uz * push * (1 - wa) }, side);
      }
    }
    if (!moved) break;
  }
}

// Automatic facing

/** The yaw from a toward b (radians from +Z toward +X), or undefined when they coincide. */
function yawBetween(a: FloorPoint, b: FloorPoint): number | undefined {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (!(dx * dx + dz * dz > 1e-6)) return undefined;
  return Math.atan2(dx, dz);
}

/** From a toward b by w along the shortest arc. */
function blendAngle(a: number, b: number, w: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * w;
}

function facingToward(t: SceneToken, ball: V3, plan: BallPlan | undefined, time: number): number {
  const net = t.side === "home" ? Math.PI : 0;
  let target = ball.floor;
  // The player playing the ball now faces where it goes next.
  const seg = plan?.segment(time);
  if (seg && seg.contact.player === t.id && seg.trajectory) {
    const u = seg.endTime > seg.startTime ? (time - seg.startTime) / (seg.endTime - seg.startTime) : 1;
    if (u < 0.35) target = seg.trajectory.end.floor;
  }
  const yaw = yawBetween(t.point, target);
  if (yaw === undefined) return net;
  // Very close to the ball the direction is noisy: blend toward the net.
  const d = Math.hypot(target.x - t.point.x, target.z - t.point.z);
  const w = Math.min(1, Math.max(0, (d - 0.15) / 0.6));
  return blendAngle(net, yaw, w);
}

/**
 * The frame as shown: players without an explicit facing turn toward the ball; a player about to play it faces where
 * it goes next. Without a ball the receiving team faces the server, everyone else the net.
 * Swift `TacticalScene.liveFrame(at:plan:)`. Web additions: until the serve is received, the server's teammates watch
 * where it goes (the receivers across the net) instead of turning round to the server behind them; and the frame
 * carries each player's motion, so players moving between markers take steps.
 */
export function sceneLiveFrame(scene: TacticalScene, time: number, plan?: BallPlan): SceneFrame {
  const f = sceneFrame(scene, time);
  // Web addition: players moving between markers take steps (zones/sceneMotion.ts).
  f.motion = sceneMotion(scene, time);
  const ball = plan?.position(time);
  const server = f.tokens.find((t) => Math.abs(t.point.z) > 9);
  const serve = plan?.segments[0];
  const serving = serve?.contact.phase === "serve" && time < serve.endTime
    ? f.tokens.find((t) => t.id === serve.contact.player) : undefined;
  const serveGoes = serving && serve ? (serve.trajectory?.end ?? serve.to).floor : undefined;
  f.tokens = f.tokens.map((t) => {
    if (t.yaw !== undefined) return t;
    if (serving && serveGoes && t.side === serving.side && t.id !== serving.id) {
      return { ...t, yaw: yawBetween(t.point, serveGoes) ?? SceneToken.facing(t) };
    }
    if (ball) return { ...t, yaw: facingToward(t, ball, plan, time) };
    if (server && server.side !== t.side) return { ...t, yaw: yawBetween(t.point, server.point) ?? SceneToken.facing(t) };
    return t;
  });
  return f;
}


// Placement help

/** Drop help for dragging players: snap to the formation's spots and keep players from standing inside each other. */
export const PlacementAssist = {
  snapRadius: 0.35,
  minSeparation: 0.5,

  /**
   * Spots worth snapping to on a side: the setup's formation anchors, base defence slots, route starts and the
   * setter's target, in world metres.
   */
  spots(side: Side, setup0?: SceneSetup): FloorPoint[] {
    const setup = setup0 ?? SceneSetup.create();
    const t = loadTemplate(SceneSetup.system(setup, side));
    if (!t) return [];
    const local: LocalPoint[] = [];
    for (const f of t.formations) if (f.rotation === SceneSetup.rotation(setup, side)) local.push(...f.players.map((p) => localPoint(p.anchor)));
    local.push(...Object.values(t.baseSlots ?? defaultBaseSlots).map(localPoint));
    local.push(...Object.values(t.routeTargets).map(localPoint));
    local.push(setterSpot(t));
    return local.map((p) => CourtFrame.world(p, side));
  },

  /** Where a dropped player ends up: on a nearby spot if one is within reach, then nudged out of other players. */
  adjust(p: FloorPoint, id: string, side: Side, others: readonly SceneToken[], spots: readonly FloorPoint[]): { point: FloorPoint; snapped?: FloorPoint } {
    let out = p;
    let snapped: FloorPoint | undefined;
    const s = minBy(spots, (q) => Math.hypot(q.x - p.x, q.z - p.z));
    if (s && Math.hypot(s.x - p.x, s.z - p.z) <= PlacementAssist.snapRadius
      && !others.some((o) => o.id !== id && Math.hypot(o.point.x - s.x, o.point.z - s.z) < PlacementAssist.minSeparation)) {
      out = s;
      snapped = s;
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const o of others) {
        if (o.id === id) continue;
        const dx = out.x - o.point.x, dz = out.z - o.point.z;
        const d = Math.hypot(dx, dz);
        if (!(d < PlacementAssist.minSeparation)) continue;
        const [ux, uz] = d > 1e-6 ? [dx / d, dz / d] : side === "home" ? [0.0, 1.0] : [0.0, -1.0];
        out = { x: o.point.x + ux * PlacementAssist.minSeparation, z: o.point.z + uz * PlacementAssist.minSeparation };
        snapped = undefined;
      }
    }
    return snapped === undefined ? { point: out } : { point: out, snapped };
  },
};
