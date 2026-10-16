// Helpers that give TypeScript values the same JSON shape as Swift's synthesized Codable (JSONEncoder),
// so files written by the iPad app and by the web app can be exchanged:
// - nil optionals are omitted (Swift uses encodeIfPresent); null is accepted as nil when decoding;
// - enums with raw values encode their raw value;
// - enums with associated values encode as {"case": {"label": value}} with "_0", "_1"... for unlabelled values
//   and {"case": {}} without values;
// - a Dictionary whose key is neither String nor Int (UUID, a raw-value enum) encodes as a flat array
//   [key0, value0, key1, value1, ...]; Set encodes as an array.

/** A JSON value as JSON.stringify writes it. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Converts a value to and from the JSON shape Swift's Codable uses for the same type. */
export interface Codec<T> {
  encode(value: T): JsonValue;
  decode(json: unknown): T;
}

/** A value that does not have the expected JSON shape (Swift's DecodingError). */
export class DecodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodingError";
  }
}

function describe(json: unknown): string {
  if (json === null) return "null";
  if (Array.isArray(json)) return "an array";
  return typeof json;
}

export function decodeNumber(json: unknown, what: string): number {
  if (typeof json !== "number" || !Number.isFinite(json)) throw new DecodingError(`${what}: expected a number, got ${describe(json)}`);
  return json;
}

export function decodeInt(json: unknown, what: string): number {
  const n = decodeNumber(json, what);
  if (!Number.isInteger(n)) throw new DecodingError(`${what}: expected an integer, got ${n}`);
  return n;
}

export function decodeString(json: unknown, what: string): string {
  if (typeof json !== "string") throw new DecodingError(`${what}: expected a string, got ${describe(json)}`);
  return json;
}

export function decodeBool(json: unknown, what: string): boolean {
  if (typeof json !== "boolean") throw new DecodingError(`${what}: expected a boolean, got ${describe(json)}`);
  return json;
}

export function decodeArray<T>(json: unknown, what: string, element: (json: unknown, what: string) => T): T[] {
  if (!Array.isArray(json)) throw new DecodingError(`${what}: expected an array, got ${describe(json)}`);
  return json.map((e, i) => element(e, `${what}[${i}]`));
}

/** A raw-value enum case. */
export function decodeRaw<T extends string | number>(json: unknown, what: string, cases: readonly T[]): T {
  if (!cases.includes(json as T)) throw new DecodingError(`${what}: ${JSON.stringify(json)} is not one of ${cases.join(", ")}`);
  return json as T;
}

/** A Dictionary with String keys (a JSON object). */
export function decodeStringDictionary<V>(json: unknown, what: string, value: (json: unknown, what: string) => V): Record<string, V> {
  const o = decodeObject(json, what);
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(o)) out[k] = value(v, `${what}.${k}`);
  return out;
}

/** A Dictionary whose key is neither String nor Int: Swift's unkeyed [key, value, key, value, ...] form. */
export function decodeFlatDictionary<K, V>(json: unknown, what: string,
                                           key: (json: unknown, what: string) => K,
                                           value: (json: unknown, what: string) => V): [K, V][] {
  if (!Array.isArray(json) || json.length % 2 !== 0) {
    throw new DecodingError(`${what}: expected an array of alternating keys and values`);
  }
  const out: [K, V][] = [];
  for (let i = 0; i < json.length; i += 2) out.push([key(json[i], `${what}[${i}]`), value(json[i + 1], `${what}[${i + 1}]`)]);
  return out;
}

export function encodeFlatDictionary<K, V>(entries: Iterable<[K, V]>, key: (k: K) => JsonValue,
                                           value: (v: V) => JsonValue): JsonValue[] {
  const out: JsonValue[] = [];
  for (const [k, v] of entries) out.push(key(k), value(v));
  return out;
}

export function decodeObject(json: unknown, what: string): Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new DecodingError(`${what}: expected an object, got ${describe(json)}`);
  }
  return json as Record<string, unknown>;
}

/** Drops undefined members: Swift's synthesized Codable omits nil optionals. */
export function compact(o: { [key: string]: JsonValue | undefined }): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** Reads the members of a keyed container. */
export class JsonReader {
  readonly o: Record<string, unknown>;

  constructor(json: unknown, readonly what: string) {
    this.o = decodeObject(json, what);
  }

  private path(key: string): string {
    return `${this.what}.${key}`;
  }

  /** True when the key is present and not null. */
  has(key: string): boolean {
    return this.o[key] !== undefined && this.o[key] !== null;
  }

  req<T>(key: string, decode: (json: unknown, what: string) => T): T {
    if (!this.has(key)) throw new DecodingError(`${this.path(key)}: missing`);
    return decode(this.o[key], this.path(key));
  }

  opt<T>(key: string, decode: (json: unknown, what: string) => T): T | undefined {
    return this.has(key) ? decode(this.o[key], this.path(key)) : undefined;
  }

  num(key: string): number { return this.req(key, decodeNumber); }
  int(key: string): number { return this.req(key, decodeInt); }
  str(key: string): string { return this.req(key, decodeString); }
  bool(key: string): boolean { return this.req(key, decodeBool); }
  optNum(key: string): number | undefined { return this.opt(key, decodeNumber); }
  optInt(key: string): number | undefined { return this.opt(key, decodeInt); }
  optStr(key: string): string | undefined { return this.opt(key, decodeString); }

  array<T>(key: string, element: (json: unknown, what: string) => T): T[] {
    return this.req(key, (j, w) => decodeArray(j, w, element));
  }

  optArray<T>(key: string, element: (json: unknown, what: string) => T): T[] | undefined {
    return this.opt(key, (j, w) => decodeArray(j, w, element));
  }

  raw<T extends string | number>(key: string, cases: readonly T[]): T {
    return this.req(key, (j, w) => decodeRaw(j, w, cases));
  }

  optRaw<T extends string | number>(key: string, cases: readonly T[]): T | undefined {
    return this.opt(key, (j, w) => decodeRaw(j, w, cases));
  }
}

/** Splits an enum with associated values, {"case": {...}}, into its case name and payload reader. */
export function decodeTagged(json: unknown, what: string): [string, JsonReader] {
  const o = decodeObject(json, what);
  const keys = Object.keys(o);
  if (keys.length !== 1) throw new DecodingError(`${what}: expected exactly one enum case, got ${keys.length} keys`);
  const tag = keys[0];
  return [tag, new JsonReader(o[tag], `${what}.${tag}`)];
}

/** An enum value with associated values, {"case": {"_0": ..., ...}} (nil values omitted). */
export function encodeTagged(tag: string, payload: { [key: string]: JsonValue | undefined } = {}): JsonObject {
  return { [tag]: compact(payload) };
}

const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A UUID (Swift encodes it as its uuidString). */
export function decodeUUID(json: unknown, what: string): string {
  const s = decodeString(json, what);
  if (!uuidPattern.test(s)) throw new DecodingError(`${what}: ${JSON.stringify(s)} is not a UUID`);
  return s;
}
