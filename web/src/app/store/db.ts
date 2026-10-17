/**
 * Everything the coach keeps, in the browser's IndexedDB on the iPad itself: players, matches, boards (Studio
 * scenes) and videos (the clip, its hall plate and the rebuilt rally). Nothing leaves the device unless the coach
 * makes a backup file.
 */
export type StoreName = "players" | "matches" | "boards" | "videos";
export const storeNames: StoreName[] = ["players", "matches", "boards", "videos"];

const DB_NAME = "coachboard";
const DB_VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;

/** The connection, opened once and opened again after it was lost (iOS drops it when the app sat in the background). */
function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  const p: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of storeNames) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const drop = () => { if (opening === p) opening = null; };
      db.onclose = drop;
      // A newer version of the app wants to upgrade the database: step aside instead of blocking it.
      db.onversionchange = () => { db.close(); drop(); };
      resolve(db);
    };
    req.onerror = () => { if (opening === p) opening = null; reject(req.error); };
  });
  opening = p;
  return p;
}

/** Forgets the connection so the next request opens a fresh one. */
function reconnect() {
  const old = opening;
  opening = null;
  old?.then((db) => db.close(), () => {});
}

/** Errors a fresh connection cannot cure (a full disk, a bad value). */
const lasting = (e: unknown) => e instanceof DOMException && ["QuotaExceededError", "DataError", "ConstraintError"].includes(e.name);

/**
 * One request in its own transaction. It settles when the transaction does, so a write that fails late (the disk is
 * full) rejects instead of looking saved; a lost connection is opened again and the request tried once more.
 */
async function run<T>(name: StoreName, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>, retry = true): Promise<T> {
  try {
    const tx = (await open()).transaction(name, mode);
    return await new Promise<T>((resolve, reject) => {
      const req = op(tx.objectStore(name));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () => reject(req.error ?? tx.error ?? new Error("The save did not go through."));
    });
  } catch (e) {
    if (!retry || lasting(e)) throw e;
    reconnect();
    return run(name, mode, op, false);
  }
}

export async function put<T extends { id: string }>(name: StoreName, value: T): Promise<void> {
  await run(name, "readwrite", (s) => s.put(value));
}

export async function get<T>(name: StoreName, id: string): Promise<T | undefined> {
  return (await run(name, "readonly", (s) => s.get(id))) as T | undefined;
}

export async function all<T>(name: StoreName): Promise<T[]> {
  return (await run(name, "readonly", (s) => s.getAll())) as T[];
}

export async function remove(name: StoreName, id: string): Promise<void> {
  await run(name, "readwrite", (s) => s.delete(id));
}

export async function clear(name: StoreName): Promise<void> {
  await run(name, "readwrite", (s) => s.clear());
}

/** Asks the browser to keep the data even when the iPad runs short of space (granted to home-screen apps). */
export async function persist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// MARK: - Backup

export interface Backup {
  format: "coachboard-backup/1";
  createdAt: string;
  stores: Record<StoreName, unknown[]>;
  /** The settings kept outside the database: team name, schedule link, last lineup. */
  local?: Record<string, string>;
}

/** The localStorage keys a backup carries. */
const localKeys = ["coachboard.settings", "coachboard.schedule", "coachboard.lastSetup", "video.markView"];

async function blobToDataURL(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${b.type || "application/octet-stream"};base64,${btoa(s)}`;
}

function dataURLToBlob(url: string): Blob {
  const [head, data] = url.split(",");
  const type = /data:([^;]+)/.exec(head)?.[1] ?? "application/octet-stream";
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Blobs (video clips, plates) become data URLs so the backup is one JSON file. */
async function encode(v: unknown): Promise<unknown> {
  if (typeof Blob !== "undefined" && v instanceof Blob) return { $blob: await blobToDataURL(v) };
  if (Array.isArray(v)) return Promise.all(v.map(encode));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = await encode(x);
    return out;
  }
  return v;
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$blob === "string") return dataURLToBlob(o.$blob);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decode(x);
    return out;
  }
  return v;
}

/** Everything in one file; `withVideos` false leaves the clips out (the rebuilt rallies stay). */
export async function makeBackup(withVideos = true): Promise<Backup> {
  const stores = {} as Record<StoreName, unknown[]>;
  for (const name of storeNames) {
    let items = await all<Record<string, unknown>>(name);
    if (name === "videos" && !withVideos) items = items.map(({ clip: _clip, ...rest }) => rest);
    stores[name] = (await encode(items)) as unknown[];
  }
  const local: Record<string, string> = {};
  try {
    for (const k of localKeys) { const v = localStorage.getItem(k); if (v !== null) local[k] = v; }
  } catch { /* private browsing: no settings to carry */ }
  return { format: "coachboard-backup/1", createdAt: new Date().toISOString(), stores, local };
}

type Item = Record<string, unknown> & { id: string };

/** What stays when a backup brings in an item this iPad already has. */
function merge(name: StoreName, incoming: Item, here: Item | undefined): Item | undefined {
  if (!here) return incoming;
  // A match keeps its longer journal (the journal only grows), a board its newest edit.
  if (name === "matches" && String(here.journal ?? "").length > String(incoming.journal ?? "").length) return undefined;
  if (name === "boards" && String(here.modifiedAt ?? "") > String(incoming.modifiedAt ?? "")) return undefined;
  // A backup made without video clips keeps the clip already on this iPad.
  if (name === "videos" && !("clip" in incoming) && "clip" in here) return { ...incoming, clip: here.clip };
  return incoming;
}

/**
 * Restores a backup: new items are added and newer ones on this iPad are kept. The whole file is checked first and
 * written in one go, so a damaged file changes nothing. Returns how many items came in.
 */
export async function restoreBackup(b: Backup): Promise<number> {
  const bad = new Error("This is not a Coach Board backup file.");
  if (b?.format !== "coachboard-backup/1" || !b.stores || typeof b.stores !== "object") throw bad;
  const incoming = storeNames.map((name) => {
    const items = b.stores[name] ?? [];
    if (!Array.isArray(items)) throw bad;
    const decoded = items.map(decode) as Item[];
    if (decoded.some((x) => !x || typeof x !== "object" || typeof x.id !== "string")) throw bad;
    return { name, items: decoded };
  });
  const writes: { name: StoreName; item: Item }[] = [];
  for (const { name, items } of incoming) {
    const here = new Map((await all<Item>(name)).map((x) => [x.id, x]));
    for (const item of items) {
      const kept = merge(name, item, here.get(item.id));
      if (kept) writes.push({ name, item: kept });
    }
  }
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The backup could not be restored."));
    try {
      for (const { name, item } of writes) tx.objectStore(name).put(item);
    } catch (e) {
      tx.abort();
      reject(e);
    }
  });
  try {
    for (const [k, v] of Object.entries(b.local ?? {})) if (localKeys.includes(k) && typeof v === "string") localStorage.setItem(k, v);
  } catch { /* private browsing: the settings stay as they are */ }
  return writes.length;
}
