// TEMP STAND-IN: replaced by the match port
// Minimal port of `LiveState.genericAnchors` (Store/LiveStore.swift) so zones/ compiles and tests before the match
// port lands.
import type { CourtPosition, LocalPoint } from "./court";

export class LiveState {
  /** Fallback anchors when no template formation applies. */
  static genericAnchors(serving: boolean): Map<CourtPosition, LocalPoint> {
    return new Map<CourtPosition, LocalPoint>([
      [1, serving ? { l: 7.5, d: 10.0 } : { l: 7.5, d: 6.5 }],
      [2, { l: 7.5, d: 1.0 }],
      [3, { l: 4.5, d: 1.0 }],
      [4, { l: 1.5, d: 1.0 }],
      [5, { l: 1.5, d: 6.5 }],
      [6, { l: 4.5, d: 7.0 }],
    ]);
  }
}
