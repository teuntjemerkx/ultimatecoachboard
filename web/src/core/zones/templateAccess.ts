// Internal: what zones/ reads from the match port's templates and court types, through their JSON fields and the
// two documented entry points (TemplateLibrary.template, LiveState.genericAnchors) only.
import type { CourtPosition, LocalPoint } from "../match/court";
import { LiveState } from "../match/liveStore";
import { TemplateLibrary, type RotationTemplate } from "../match/rotationTemplate";

export type Template = RotationTemplate;
export type TemplateFormation = RotationTemplate["formations"][number];
export type TemplatePlayer = TemplateFormation["players"][number];

export const allPositions: readonly CourtPosition[] = [1, 2, 3, 4, 5, 6];

export function isFrontRow(p: CourtPosition): boolean {
  return p === 2 || p === 3 || p === 4;
}

export function positionLabel(p: CourtPosition): string {
  return `P${p}`;
}

/** Swift `CourtPosition(rawValue:)`. */
export function courtPosition(n: number): CourtPosition | undefined {
  return Number.isInteger(n) && n >= 1 && n <= 6 ? (n as CourtPosition) : undefined;
}

/** Swift `LocalPoint(_ pair: [Double])`. */
export function localPoint(pair: readonly number[]): LocalPoint {
  return { l: pair[0], d: pair[1] };
}

export function distance(a: LocalPoint, b: LocalPoint): number {
  const dl = b.l - a.l, dd = b.d - a.d;
  return Math.sqrt(dl * dl + dd * dd);
}

/** Swift `RotationTemplate.formation(rotation:phase:)`. */
export function formationOf(t: Template, rotation: number, phase: string): TemplateFormation | undefined {
  return t.formations.find((f) => f.rotation === rotation && f.phase === phase);
}

/** Swift `Formation.positions`: court position to anchor (a later player on the same position wins). */
export function formationPositions(f: TemplateFormation): Map<CourtPosition, LocalPoint> {
  const out = new Map<CourtPosition, LocalPoint>();
  for (const p of f.players) {
    const cp = courtPosition(p.position);
    if (cp !== undefined) out.set(cp, localPoint(p.anchor));
  }
  return out;
}

/** `LiveState.genericAnchors(serving:)` as a Map, whether the match port returns a Map or a record. */
export function genericAnchors(serving: boolean): Map<CourtPosition, LocalPoint> {
  const anchors: unknown = LiveState.genericAnchors(serving);
  if (anchors instanceof Map) return new Map(anchors as Map<CourtPosition, LocalPoint>);
  const out = new Map<CourtPosition, LocalPoint>();
  const record = anchors as Partial<Record<number, LocalPoint>>;
  for (const p of allPositions) {
    const v = record[p];
    if (v) out.set(p, v);
  }
  return out;
}

/** Swift `try? TemplateLibrary.template(id:)`. */
export function loadTemplate(id: string): Template | undefined {
  try {
    return TemplateLibrary.template(id) ?? undefined;
  } catch {
    return undefined;
  }
}
