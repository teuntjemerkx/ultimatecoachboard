// Value types of Store/LiveStore.swift that the journal payloads also use. They live apart from liveStore.ts so
// that journal.ts and liveStore.ts do not import each other.
import { type JsonValue, JsonReader, decodeRaw } from "./codable";
import { FloorPoint } from "./court";

export type CoachMode = "solo" | "advanced";

export const CoachMode = {
  allCases: ["solo", "advanced"] as readonly CoachMode[],

  decode(json: unknown, what = "CoachMode"): CoachMode {
    return decodeRaw(json, what, CoachMode.allCases);
  },
};

/** Ink drawn on the board, stored in court metres so it survives 2D/3D and replay. */
export interface InkStroke {
  points: FloorPoint[];
  width: number;
}

export const InkStroke = {
  make(points: readonly FloorPoint[], width = 0.06): InkStroke {
    return { points: [...points], width };
  },

  encode(s: InkStroke): JsonValue {
    return { points: s.points.map(FloorPoint.encode), width: s.width };
  },

  decode(json: unknown, what = "InkStroke"): InkStroke {
    const r = new JsonReader(json, what);
    return { points: r.array("points", FloorPoint.decode), width: r.num("width") };
  },
};
