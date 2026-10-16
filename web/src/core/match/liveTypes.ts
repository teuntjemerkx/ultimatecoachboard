// TEMP STAND-IN: replaced by the match port
// Minimal port of InkStroke (Store/LiveStore.swift) so zones/ compiles and tests before the match port lands.
import type { FloorPoint } from "./court";

/** Ink drawn on the board, stored in court metres so it survives 2D/3D and replay. */
export interface InkStroke {
  points: FloorPoint[];
  width: number;
}

export const InkStroke = {
  make(points: readonly FloorPoint[], width = 0.06): InkStroke {
    return { points: [...points], width };
  },
};
