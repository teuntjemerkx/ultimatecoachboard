// Port of Templates/RouteTiming.swift: the route timing model of Appendix A1.
import { type JsonValue, JsonReader } from "./codable";
import { LocalPoint } from "./court";
import { RotationTemplate } from "./rotationTemplate";

/** The route timing model of Appendix A1. All values are per-team settings (seconds, metres per second). */
export interface TimingModel {
  serveToPass: number;
  passToSet: number;
  nonPasserStart: number;
  passerRecovery: number;
  setterSpeed: number;
  hitterSpeed: number;
  setterArriveBeforeSet: number;
  pinSetFlight: number;
  backRowSetFlight: number;
  approachDuration: number;
  quickLead: number;
}

const timingKeys = ["serveToPass", "passToSet", "nonPasserStart", "passerRecovery", "setterSpeed", "hitterSpeed",
                    "setterArriveBeforeSet", "pinSetFlight", "backRowSetFlight", "approachDuration", "quickLead"] as const;

export const TimingModel = {
  /** Swift `TimingModel()`: the defaults of Appendix A1. */
  make(): TimingModel {
    return { serveToPass: 1.2, passToSet: 1.1, nonPasserStart: 0.25, passerRecovery: 0.2, setterSpeed: 4.5,
             hitterSpeed: 5.0, setterArriveBeforeSet: 0.3, pinSetFlight: 0.8, backRowSetFlight: 0.7,
             approachDuration: 0.75, quickLead: 0.45 };
  },

  setTime(m: TimingModel): number {
    return m.serveToPass + m.passToSet;
  },

  /** When an attacker (or the setter) must arrive on a route; undefined for routes without a deadline. */
  deadline(m: TimingModel, route: string): number | undefined {
    const setTime = TimingModel.setTime(m);
    switch (route) {
      case "target": return setTime - m.setterArriveBeforeSet;
      case "left":
      case "right": return setTime + m.pinSetFlight - m.approachDuration;
      case "quick": return setTime - m.quickLead;
      case "pipe":
      case "dball": return setTime + m.backRowSetFlight - m.approachDuration;
      default: return undefined;
    }
  },

  encode(m: TimingModel): JsonValue {
    return Object.fromEntries(timingKeys.map((k) => [k, m[k]]));
  },

  decode(json: unknown, what = "TimingModel"): TimingModel {
    const r = new JsonReader(json, what);
    return Object.fromEntries(timingKeys.map((k) => [k, r.num(k)])) as unknown as TimingModel;
  },
};

export interface RouteCheck {
  role: string;
  position: number;
  route: string;
  length: number;
  arrival: number;
  deadline: number;
}

export const RouteCheck = {
  /** Deadline minus arrival; negative means the app shows a LATE chip. */
  slack(c: RouteCheck): number {
    return c.deadline - c.arrival;
  },

  isLate(c: RouteCheck): boolean {
    return RouteCheck.slack(c) < 0;
  },
};

export const RouteTiming = {
  check(formation: RotationTemplate.Formation, targets: Readonly<Record<string, readonly number[]>>,
        model: TimingModel = TimingModel.make()): RouteCheck[] {
    const out: RouteCheck[] = [];
    for (const p of formation.players) {
      const route = p.route;
      if (route === undefined || !Object.prototype.hasOwnProperty.call(targets, route)) continue;
      const dest = targets[route];
      const deadline = TimingModel.deadline(model, route);
      if (dest.length !== 2 || deadline === undefined) continue;
      const length = LocalPoint.distance(RotationTemplate.point(p), LocalPoint.fromPair(dest));
      const speed = route === "target" ? model.setterSpeed : model.hitterSpeed;
      const start = p.passes ? model.serveToPass + model.passerRecovery : model.nonPasserStart;
      out.push({ role: p.role, position: p.position, route, length, arrival: start + length / speed, deadline });
    }
    return out;
  },
};
