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

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of storeNames) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function put<T extends { id: string }>(name: StoreName, value: T): Promise<void> {
  await request((await store(name, "readwrite")).put(value));
}

export async function get<T>(name: StoreName, id: string): Promise<T | undefined> {
  return (await request((await store(name, "readonly")).get(id))) as T | undefined;
}

export async function all<T>(name: StoreName): Promise<T[]> {
  return (await request((await store(name, "readonly")).getAll())) as T[];
}

export async function remove(name: StoreName, id: string): Promise<void> {
  await request((await store(name, "readwrite")).delete(id));
}

export async function clear(name: StoreName): Promise<void> {
  await request((await store(name, "readwrite")).clear());
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
}

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
  return { format: "coachboard-backup/1", createdAt: new Date().toISOString(), stores };
}

/** Restores a backup: items with the same id are replaced, others are added. Returns how many items came in. */
export async function restoreBackup(b: Backup): Promise<number> {
  if (b.format !== "coachboard-backup/1") throw new Error("This is not a Coach Board backup file.");
  let n = 0;
  for (const name of storeNames) {
    for (const item of (b.stores[name] ?? []).map(decode) as { id: string }[]) {
      await put(name, item);
      n++;
    }
  }
  return n;
}
