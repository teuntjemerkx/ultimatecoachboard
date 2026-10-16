// Port of Rules/RuleCourtProfile.swift.
import fivbSeniorJSON from "../resources/profiles/fivb-senior.json";
import { type JsonValue, JsonReader, compact, decodeNumber, decodeStringDictionary } from "./codable";

/**
 * A Rule & Court Profile (blueprint Section 2.7, Appendix B5). Profiles are data: federation and youth formats
 * are new JSON files, never new code.
 */
export interface RuleCourtProfile {
  format: string;
  name: string;
  source?: string;
  court: RuleCourtProfile.Court;
  net: RuleCourtProfile.Net;
  playersPerSide: number;
  rotation: RuleCourtProfile.Rotation;
  overlap: RuleCourtProfile.Overlap;
  libero: RuleCourtProfile.Libero;
  substitutions: RuleCourtProfile.Substitutions;
  scoring: RuleCourtProfile.Scoring;
  timeOuts: RuleCourtProfile.TimeOuts;
}

export declare namespace RuleCourtProfile {
  interface Court {
    length: number;
    width: number;
    attackLine: number;
    lineWidth: number;
    freeZoneMin: number;
  }

  interface Net {
    heightPresets: Record<string, number>;
    height: number;
    antennaAboveTape: number;
    tapeWidth: number;
  }

  interface Rotation {
    enabled: boolean;
  }

  interface Footprint {
    footLength: number;
    footWidth: number;
    stanceWidth: number;
  }

  interface Overlap {
    checkServingTeam: boolean;
    checkReceivingTeam: boolean;
    requireInsideCourt: boolean;
    serverExempt: boolean;
    footprint: Footprint;
  }

  interface Libero {
    allowed: boolean;
    maxPerTeam: number;
    mayServe: boolean;
  }

  interface Substitutions {
    maxPerSet: number;
  }

  interface Scoring {
    pointsPerSet: number;
    decidingSetPoints: number;
    winBy: number;
    setsToWin: number;
  }

  interface TimeOuts {
    perSet: number;
    seconds: number;
  }
}

export type Scoring = RuleCourtProfile.Scoring;

/** Functions of `RuleCourtProfile.Scoring`. */
export const Scoring = {
  /** Number of the deciding set, e.g. 5 when three sets win the match. */
  decidingSetNumber(s: Scoring): number {
    return s.setsToWin * 2 - 1;
  },

  /** Swift `targetPoints(forSet:)`. */
  targetPoints(s: Scoring, setNumber: number): number {
    return setNumber === Scoring.decidingSetNumber(s) ? s.decidingSetPoints : s.pointsPerSet;
  },

  encode(s: Scoring): JsonValue {
    return { pointsPerSet: s.pointsPerSet, decidingSetPoints: s.decidingSetPoints, winBy: s.winBy, setsToWin: s.setsToWin };
  },

  decode(json: unknown, what = "Scoring"): Scoring {
    const r = new JsonReader(json, what);
    return { pointsPerSet: r.int("pointsPerSet"), decidingSetPoints: r.int("decidingSetPoints"),
             winBy: r.int("winBy"), setsToWin: r.int("setsToWin") };
  },
};

export type ProfileErrorKind = "resourceMissing" | "unsupportedFormat";

/** Swift `ProfileError`: `.resourceMissing(name)` or `.unsupportedFormat(format)`. */
export class ProfileError extends Error {
  constructor(readonly kind: ProfileErrorKind, readonly detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "ProfileError";
  }
}

function decodeProfile(json: unknown): RuleCourtProfile {
  const r = new JsonReader(json, "RuleCourtProfile");
  const court = new JsonReader(r.o.court, "court");
  const net = new JsonReader(r.o.net, "net");
  const overlap = new JsonReader(r.o.overlap, "overlap");
  const footprint = new JsonReader(overlap.o.footprint, "overlap.footprint");
  const libero = new JsonReader(r.o.libero, "libero");
  const timeOuts = new JsonReader(r.o.timeOuts, "timeOuts");
  return {
    format: r.str("format"),
    name: r.str("name"),
    source: r.optStr("source"),
    court: { length: court.num("length"), width: court.num("width"), attackLine: court.num("attackLine"),
             lineWidth: court.num("lineWidth"), freeZoneMin: court.num("freeZoneMin") },
    net: { heightPresets: net.req("heightPresets", (j, w) => decodeStringDictionary(j, w, decodeNumber)),
           height: net.num("height"), antennaAboveTape: net.num("antennaAboveTape"), tapeWidth: net.num("tapeWidth") },
    playersPerSide: r.int("playersPerSide"),
    rotation: { enabled: new JsonReader(r.o.rotation, "rotation").bool("enabled") },
    overlap: { checkServingTeam: overlap.bool("checkServingTeam"), checkReceivingTeam: overlap.bool("checkReceivingTeam"),
               requireInsideCourt: overlap.bool("requireInsideCourt"), serverExempt: overlap.bool("serverExempt"),
               footprint: { footLength: footprint.num("footLength"), footWidth: footprint.num("footWidth"),
                            stanceWidth: footprint.num("stanceWidth") } },
    libero: { allowed: libero.bool("allowed"), maxPerTeam: libero.int("maxPerTeam"), mayServe: libero.bool("mayServe") },
    substitutions: { maxPerSet: new JsonReader(r.o.substitutions, "substitutions").int("maxPerSet") },
    scoring: r.req("scoring", Scoring.decode),
    timeOuts: { perSet: timeOuts.int("perSet"), seconds: timeOuts.int("seconds") },
  };
}

export const RuleCourtProfile = {
  supportedFormat: "cb.rule-court-profile/1",

  /** Decodes a profile from JSON text or an already parsed JSON value; rejects other formats. */
  decode(data: unknown): RuleCourtProfile {
    const profile = decodeProfile(typeof data === "string" ? JSON.parse(data) : data);
    if (profile.format !== RuleCourtProfile.supportedFormat) throw new ProfileError("unsupportedFormat", profile.format);
    return profile;
  },

  encode(p: RuleCourtProfile): JsonValue {
    return compact({
      format: p.format, name: p.name, source: p.source,
      court: { ...p.court }, net: { ...p.net, heightPresets: { ...p.net.heightPresets } },
      playersPerSide: p.playersPerSide, rotation: { ...p.rotation },
      overlap: { ...p.overlap, footprint: { ...p.overlap.footprint } },
      libero: { ...p.libero }, substitutions: { ...p.substitutions }, scoring: { ...p.scoring }, timeOuts: { ...p.timeOuts },
    });
  },

  /** The shipped senior indoor profile (a fresh copy on every call). */
  fivbSenior(): RuleCourtProfile {
    return RuleCourtProfile.decode(fivbSeniorJSON);
  },
};
