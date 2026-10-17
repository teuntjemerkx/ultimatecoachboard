// The Studio's body separation off the main thread: a rally's SeparationTrack (bodyTrack.ts) is solved here from the
// start, a slice at a time, and the moments are sent back as they come, so an edit never stops the page while the
// rally is solved again. A new request replaces the one being solved.
import { PlayerBodies, type SeparationTrack } from "../../core/spatial";
import type { TacticalScene } from "../../core/zones";
import { studioTrack } from "./bodyTrack";

export type BodiesRequest =
  | { kind: "solve"; job: number; scene: TacticalScene; women: boolean; athletes: boolean }
  | { kind: "stop" };

/** Moments `from` on: their times, and per moment every player's offset (x then z, in the order of `ids`). */
export interface BodiesReply {
  job: number;
  from: number;
  times: Float64Array;
  ids: string[];
  offsets: Float64Array;
}

/** The worker's global scope (typed by hand: the project compiles against the DOM library). */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<BodiesRequest>) => void) | null;
  postMessage(message: BodiesReply, transfer: Transferable[]): void;
};

let current: { job: number; track: SeparationTrack; sent: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Sends the moments solved since the last reply. */
function send(c: { job: number; track: SeparationTrack; sent: number }) {
  const { times, offsets } = c.track.slice(c.sent);
  if (times.length === 0) return;
  const ids = [...offsets[0].keys()];
  const flat = new Float64Array(times.length * ids.length * 2);
  offsets.forEach((m, k) => ids.forEach((id, i) => {
    const q = m.get(id);
    flat[(k * ids.length + i) * 2] = q ? q.x : NaN;
    flat[(k * ids.length + i) * 2 + 1] = q ? q.z : NaN;
  }));
  const reply: BodiesReply = { job: c.job, from: c.sent, times: Float64Array.from(times), ids, offsets: flat };
  scope.postMessage(reply, [reply.times.buffer, flat.buffer]);
  c.sent += times.length;
}

/** Solves for a short while, sends what it found, and comes back after any new request has been read. */
function pump() {
  timer = undefined;
  const c = current;
  if (!c) return;
  const done = c.track.solveFor(25);
  send(c);
  if (done) current = undefined;
  else timer = setTimeout(pump, 0);
}

scope.onmessage = (e: MessageEvent<BodiesRequest>) => {
  const msg = e.data;
  if (msg.kind === "stop") {
    current = undefined;
    return;
  }
  PlayerBodies.women = msg.women;
  PlayerBodies.athletes = msg.athletes;
  current = { job: msg.job, track: studioTrack(msg.scene), sent: 0 };
  timer ??= setTimeout(pump, 0);
};
