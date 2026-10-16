// Small helpers that reproduce Swift semantics the port depends on (rounding, value equality and copies, UUIDs,
// Foundation dates). Internal to spatial/ and zones/.

/** Swift's `rounded()`: to nearest, ties away from zero (JS Math.round rounds ties toward +infinity). */
export function swiftRound(x: number): number {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(Math.abs(x));
  return x < 0 ? -r : r;
}

/** C `copysign`: the magnitude of `a` with the sign of `b` (including -0). */
export function copysign(a: number, b: number): number {
  const negative = b < 0 || Object.is(b, -0);
  return negative ? -Math.abs(a) : Math.abs(a);
}

/** Clamp to a closed range. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** The first element with the smallest key (Swift's `min(by:)` keeps the first of equal minima). */
export function minBy<T>(items: readonly T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestKey = 0;
  let first = true;
  for (const item of items) {
    const k = key(item);
    if (first || k < bestKey) {
      best = item;
      bestKey = k;
      first = false;
    }
  }
  return best;
}

/** The first element with the largest key (Swift's `max(by:)` keeps the first of equal maxima). */
export function maxBy<T>(items: readonly T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestKey = 0;
  let first = true;
  for (const item of items) {
    const k = key(item);
    if (first || k > bestKey) {
      best = item;
      bestKey = k;
      first = false;
    }
  }
  return best;
}

/** A new random UUID in Foundation's uppercase form. */
export function newUUID(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().toUpperCase();
  const hex = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[8 + Math.floor(Math.random() * 4)];
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

/** Seconds between 1970-01-01 and Foundation's reference date 2001-01-01 (UTC). */
export const referenceDateOffset = 978307200;

/** `Date()` as Swift's default JSONEncoder writes it: seconds since 2001-01-01 00:00:00 UTC. */
export function referenceDateNow(): number {
  return Date.now() / 1000 - referenceDateOffset;
}

/**
 * Structural equality of plain data (Swift's synthesized `==`): arrays element-wise, objects key-wise with a
 * missing key equal to an `undefined` one (nil), Maps entry-wise, numbers by value.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

/** A deep copy of plain data (Swift value semantics), dropping `undefined` keys. */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as T;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, deepClone(v)])) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = deepClone(v);
  return out as T;
}

/** JSON as Swift's Codable reads it: `null` is nil, so null members become absent (undefined). */
export function stripNulls<T>(value: unknown): T {
  if (value === null) return undefined as T;
  if (Array.isArray(value)) return value.map((v) => stripNulls(v)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null) out[k] = stripNulls(v);
    return out as T;
  }
  return value as T;
}
