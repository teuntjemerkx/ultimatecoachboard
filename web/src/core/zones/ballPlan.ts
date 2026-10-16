// Port of Zones/BallPlan.swift: ball contacts placed by the coach and the solved flights between them (Section 5.4).
import type { FloorPoint, Side } from "../match/court";
import { Aero, BallFlight, FlightSolver, type Trajectory } from "../spatial/ballFlight";
import { V3 } from "../spatial/math3d";
import { BodyMetrics } from "../spatial/skeleton";
import { swiftRound } from "../spatial/swiftCompat";
import { sceneFrame, sceneTimeline, type RallyPhase } from "./sceneTimeline";
import { SceneToken, type TacticalScene } from "./tacticalScene";

/** How a contact sends the ball on, with the defaults of Section 5.4. */
export type ContactKind =
  | "floatServe" | "jumpServe" | "pass" | "quickSet" | "secondTempoSet" | "highSet" | "attack" | "freeball" | "dig";

/** Swift `ContactKind.Launch`: driven contacts have a launch speed; lobbed ones an apex above the tape. */
export type ContactLaunch =
  | { kind: "speed"; speed: number; aero: Aero }
  | { kind: "apexAboveTape"; height: number; aero: Aero };

const contactTitles: Record<ContactKind, string> = {
  floatServe: "FLOAT",
  jumpServe: "JUMP SERVE",
  pass: "PASS",
  quickSet: "QUICK",
  secondTempoSet: "2ND TEMPO",
  highSet: "HIGH SET",
  attack: "ATTACK",
  freeball: "FREE BALL",
  dig: "DIG",
};

export const ContactKind = {
  allCases: ["floatServe", "jumpServe", "pass", "quickSet", "secondTempoSet", "highSet", "attack", "freeball", "dig"] as readonly ContactKind[],

  title(kind: ContactKind): string {
    return contactTitles[kind];
  },

  /**
   * Float serve 14 to 18 m/s, jump serve 18 to 28, pass apex 1.5 to 3 m over the tape, sets by tempo, attacks at
   * 25 m/s with topspin (a men's hitter profile), free balls and digs as soft lobs.
   */
  launch(kind: ContactKind): ContactLaunch {
    switch (kind) {
      case "floatServe": return { kind: "speed", speed: 16, aero: Aero.float };
      case "jumpServe": return { kind: "speed", speed: 22, aero: Aero.topspin };
      case "pass": return { kind: "apexAboveTape", height: 2.0, aero: Aero.soft };
      case "quickSet": return { kind: "apexAboveTape", height: 0.5, aero: Aero.soft };
      case "secondTempoSet": return { kind: "apexAboveTape", height: 1.5, aero: Aero.soft };
      case "highSet": return { kind: "apexAboveTape", height: 3.5, aero: Aero.soft };
      case "attack": return { kind: "speed", speed: 25, aero: Aero.topspin };
      case "freeball": return { kind: "apexAboveTape", height: 1.5, aero: Aero.soft };
      case "dig": return { kind: "apexAboveTape", height: 1.2, aero: Aero.soft };
    }
  },

  /** The kinds that make sense at a marker, the first being the default. */
  choices(phase: RallyPhase): ContactKind[] {
    switch (phase) {
      case "serve": return ["floatServe", "jumpServe"];
      case "receive": return ["pass", "dig"];
      case "set": return ["highSet", "secondTempoSet", "quickSet"];
      case "attack": return ["attack", "freeball"];
      case "cover": case "defence": return ["dig", "freeball", "attack"];
    }
  },

  /** Where the ball is met relative to the player standing at `p` facing `facing`. */
  contactPoint(kind: ContactKind, p: FloorPoint, facing: number, metrics: BodyMetrics): V3 {
    const fwd = new V3(Math.sin(facing), 0, Math.cos(facing));
    const base = V3.fromFloor(p);
    switch (kind) {
      case "floatServe": return base.add(fwd.mul(0.3)).add(new V3(0, metrics.standingReach, 0));
      case "jumpServe": return base.add(fwd.mul(0.5)).add(new V3(0, metrics.standingReach + 0.5, 0));
      case "attack": return base.add(fwd.mul(0.3)).add(new V3(0, metrics.standingReach + 0.6, 0));
      case "quickSet": case "secondTempoSet": case "highSet": return base.add(fwd.mul(0.15)).add(new V3(0, metrics.stature + 0.15, 0));
      case "pass": return base.add(fwd.mul(0.45)).add(new V3(0, 0.75, 0));
      case "dig": return base.add(fwd.mul(0.45)).add(new V3(0, 0.45, 0));
      case "freeball": return base.add(fwd.mul(0.4)).add(new V3(0, 1.0, 0));
    }
  },
};

/** A ball contact placed by the coach (Section 3.3): who plays the ball, at which marker, and how. */
export interface BallContact {
  phase: RallyPhase;
  player: string;
  kind: ContactKind;
}

export const BallContact = {
  create(phase: RallyPhase, player: string, kind: ContactKind): BallContact {
    return { phase, player, kind };
  },
};

/** One flight of a ball plan (Swift `BallPlan.Segment`). */
export class BallPlanSegment {
  constructor(
    readonly contact: BallContact,
    readonly playerLabel: string,
    /** Timeline span (phase-index units) the flight occupies. */
    readonly startTime: number,
    readonly endTime: number,
    readonly from: V3,
    readonly to: V3,
    readonly trajectory: Trajectory | undefined,
  ) {}

  /** "HIGH SET · apex 5.9 m · 1.48 s" or "ATTACK 25 m/s · 0.31 m over the tape · 1.02 s". */
  summary(netHeight: number): string {
    const t = this.trajectory;
    const title = contactTitles[this.contact.kind];
    if (!t) return `${title} · out of reach`;
    const parts = [`${this.playerLabel} ${title}`];
    const launch = ContactKind.launch(this.contact.kind);
    if (launch.kind === "speed") parts.push(`${swiftRound(launch.speed)} m/s`);
    const n = t.netCrossing(netHeight);
    if (n) {
      if (!n.insideAntennas) parts.push("outside the antenna");
      else parts.push(n.clearance >= 0 ? `${n.clearance.toFixed(2)} m over the tape` : "into the net");
    } else {
      parts.push(`apex ${t.apex.toFixed(1)} m`);
    }
    parts.push(`${t.duration.toFixed(2)} s`);
    return parts.join(" · ");
  }
}

/** The ball through a scene's timeline: one solved flight between consecutive contacts. */
export class BallPlan {
  constructor(readonly segments: BallPlanSegment[]) {}

  /**
   * The ball at a timeline position: in the hands at a contact, in flight between contacts (at physical pace across
   * its timeline span). Undefined without contacts or before the first contact's marker.
   */
  position(time: number): V3 | undefined {
    const first = this.segments[0];
    if (!first || !(time >= first.startTime - 1e-9)) return undefined;
    for (const s of this.segments) {
      if (!(time <= s.endTime + 1e-9)) continue;
      const t = s.trajectory;
      if (!t || !(s.endTime > s.startTime)) return s.from;
      const u = Math.max(0, Math.min(1, (time - s.startTime) / (s.endTime - s.startTime)));
      return t.position(u * t.duration);
    }
    const last = this.segments[this.segments.length - 1];
    return last.trajectory?.end ?? last.to;
  }

  /** The segment in flight (or about to start) at a timeline position. */
  segment(time: number): BallPlanSegment | undefined {
    const inFlight = this.segments.find((s) => time >= s.startTime - 1e-9 && time < s.endTime);
    if (inFlight) return inFlight;
    for (let i = this.segments.length - 1; i >= 0; i--) if (time >= this.segments[i].startTime - 1e-9) return this.segments[i];
    return undefined;
  }
}

/** The default landing for the last flight: deep in the middle of the half across the net from the hitter. */
export function defaultLanding(side: Side): FloorPoint {
  return { x: 0, z: side === "home" ? -6 : 6 };
}

/**
 * Solves the flights between the contacts in timeline order (Section 5.4). Expensive (RK4 shooting), so callers cache
 * it per scene value. Swift `TacticalScene.ballPlan(netHeight:)`.
 */
export function sceneBallPlan(scene: TacticalScene, netHeight = 2.43): BallPlan {
  const line = sceneTimeline(scene);
  const contacts = (scene.contacts ?? [])
    .map((c): [BallContact, number] => [c, line.indexOf(c.phase)])
    .filter((e) => e[1] >= 0)
    .sort((a, b) => a[1] - b[1]);
  if (contacts.length === 0) return new BallPlan([]);
  const points: V3[] = [];
  const labels: string[] = [];
  const sides: Side[] = [];
  for (const [c, i] of contacts) {
    const f = sceneFrame(scene, i);
    const t = f.tokens.find((tok) => tok.id === c.player);
    if (!t) return new BallPlan([]);
    points.push(ContactKind.contactPoint(c.kind, t.point, SceneToken.facing(t), new BodyMetrics(SceneToken.effectiveStature(t))));
    labels.push(t.side === "home" ? `#${t.label}` : t.label);
    sides.push(t.side);
  }
  const segments: BallPlanSegment[] = [];
  contacts.forEach(([c, i], k) => {
    const last = k === contacts.length - 1;
    let to: V3;
    let endTime: number;
    if (last) {
      const landing = scene.ballLanding ?? defaultLanding(sides[k]);
      to = V3.fromFloor(landing, scene.ballLanding === undefined ? BallFlight.radius : Math.max(BallFlight.radius, scene.ballLandingHeight ?? 0));
      endTime = Math.min(i + 1, Math.max(line.length - 1, i));
    } else {
      to = points[k + 1];
      endTime = contacts[k + 1][1];
    }
    const from = points[k];
    let trajectory: Trajectory | undefined;
    const launch = ContactKind.launch(c.kind);
    if (launch.kind === "speed") {
      trajectory = FlightSolver.aim(from, to, launch.speed, launch.aero)
        ?? FlightSolver.lob(from, to, Math.max(from.y, netHeight + 1) + 0.5, launch.aero);
    } else {
      trajectory = FlightSolver.lob(from, to, netHeight + launch.height, launch.aero);
    }
    segments.push(new BallPlanSegment(c, labels[k], i, endTime, from, to, trajectory));
  });
  return new BallPlan(segments);
}
