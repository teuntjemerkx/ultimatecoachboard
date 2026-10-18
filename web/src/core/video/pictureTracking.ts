// Web addition: following the players the coach tapped from box to box in the picture (see PictureTracker).
import { Hungarian } from "./videoMath";

/** A box in the picture, pixels (origin top-left). */
export interface PictureBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A person the detector boxed in one frame read, with the mean jersey colour (r, g, b in 0...1) when known. */
export interface PersonBox extends PictureBox {
  appearance?: number[];
}

/** The people boxed in one frame read. */
export interface PictureFrame {
  time: number;
  people: readonly PersonBox[];
}

/** Where a player was tapped: a frame and the box of theirs in it. */
export interface PictureKey {
  frame: number;
  box: number;
}

export interface PictureTrackerSettings {
  /** How far a box may move between two sightings, in its own heights: `reach` at once plus `speed` per second. */
  reach: number;
  speed: number;
  maxReach: number;
  /** The prediction's uncertainty, in box heights: `sigma` at once plus `sigmaGrowth` per second unseen. */
  sigma: number;
  sigmaGrowth: number;
  /** The cost of a frame without a sighting, against which each pairing's cost is weighed. */
  missCost: number;
  /** Cost per squared log of the change in box height, and per squared jersey colour distance. */
  sizeWeight: number;
  appearanceWeight: number;
  /** A passing track (someone nobody tapped) ends after this long unseen, seconds. */
  passingCoast: number;
  /** A lost box's velocity carries it this long at most, seconds; then it waits where it was. */
  lead: number;
}

export const defaultPictureTracker: PictureTrackerSettings = {
  reach: 0.35, speed: 4, maxReach: 3, sigma: 0.12, sigmaGrowth: 1.2, missCost: 16, sizeWeight: 12, appearanceWeight: 40,
  passingCoast: 0.5, lead: 0.3,
};

/** The point a box is followed by: the middle of the body, a third down the box (its top half is rarely cut off). */
export function anchorOf(b: PictureBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + 0.35 * b.h };
}

export function boxOverlap(a: PictureBox, b: PictureBox): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = w * h;
  return i / (a.w * a.h + b.w * b.h - i);
}

/** One followed body: its last box, its velocity in the picture and its jersey colour. */
class Follower {
  x: number;
  y: number;
  h: number;
  vx = 0;
  vy = 0;
  appearance?: number[];

  constructor(box: PersonBox, public time: number) {
    const a = anchorOf(box);
    this.x = a.x;
    this.y = a.y;
    this.h = box.h;
    this.appearance = box.appearance;
  }

  take(box: PersonBox, time: number) {
    const a = anchorOf(box), dt = Math.abs(time - this.time);
    if (dt > 1e-6 && dt < 0.3) {
      // Velocity in the direction of the pass (time runs backward in a backward pass, and so does this).
      this.vx = 0.6 * this.vx + (0.4 * (a.x - this.x)) / dt;
      this.vy = 0.6 * this.vy + (0.4 * (a.y - this.y)) / dt;
    } else {
      this.vx = 0;
      this.vy = 0;
    }
    this.x = a.x;
    this.y = a.y;
    this.h = 0.7 * this.h + 0.3 * box.h;
    if (box.appearance) {
      const m = this.appearance;
      this.appearance = m && m.length === box.appearance.length ? m.map((v, i) => v + 0.1 * (box.appearance![i] - v)) : box.appearance;
    }
    this.time = time;
  }
}

/**
 * Follows the players the coach tapped from box to box through the frames read (30 a second: the detector boxes
 * everyone in every frame, also where the pose model does not run), by the middle of the body, not the feet: between
 * two frames a box moves a few pixels, while the floor point read from the feet can jump metres from a low camera.
 *
 * Each player has one or more keys (a frame and their box in it). A key holds the player there whatever the tracking
 * says, so a second tap corrects a player who was lost. From each key the player is followed forward to their next
 * key and backward to the one before; between two keys where the two disagree, the nearer key wins. Everyone nobody
 * tapped gets a passing track of their own that competes for the boxes, so a player waiting for their box does not
 * take a bystander's. A box moves at most `reach + speed * dt` of its height, its predicted place carried by its
 * velocity for at most `lead` seconds; a pairing costs its distance in prediction sigmas, the change in box height and
 * the jersey colour, and is taken only when that beats a miss (Hungarian assignment per frame). `allowed`, when given,
 * forbids a player a box (the other side of the net).
 *
 * Returns, per player and frame, the index of the player's box in that frame or -1.
 */
export const PictureTracker = {
  follow(frames: readonly PictureFrame[], players: readonly { keys: readonly PictureKey[] }[],
    settings: PictureTrackerSettings = defaultPictureTracker,
    allowed?: (player: number, frame: number, box: PersonBox) => boolean): number[][] {
    const n = frames.length;
    const keysOf = players.map((p) => [...p.keys].sort((a, b) => a.frame - b.frame));
    const forward = PictureTracker.pass(frames, keysOf, true, settings, allowed);
    const backward = PictureTracker.pass(frames, keysOf, false, settings, allowed);
    const out = players.map(() => new Array<number>(n).fill(-1));
    /** How far each player's chosen box is from the key it was followed from, seconds (for settling clashes). */
    const distance = players.map(() => new Array<number>(n).fill(Infinity));
    keysOf.forEach((keys, p) => {
      if (keys.length === 0) return;
      let i = 0;
      for (let k = 0; k < n; k++) {
        while (i < keys.length && keys[i].frame < k) i++;
        const t = frames[k].time;
        const key = keys.find((q) => q.frame === k);
        if (key) { out[p][k] = key.box; distance[p][k] = 0; continue; }
        const before = i > 0 ? keys[i - 1] : undefined, after = i < keys.length ? keys[i] : undefined;
        const f = before ? forward[p][k] : -1, b = after ? backward[p][k] : -1;
        const df = before ? t - frames[before.frame].time : Infinity, db = after ? frames[after.frame].time - t : Infinity;
        let pick = -1, d = Infinity;
        if (f >= 0 && (b < 0 || f === b || df <= db)) { pick = f; d = f === b ? Math.min(df, db) : df; }
        else if (b >= 0) { pick = b; d = db; }
        out[p][k] = pick;
        distance[p][k] = d;
      }
    });
    // Two players on one box: the one followed from the nearer key keeps it.
    for (let k = 0; k < n; k++) {
      const owner = new Map<number, number>();
      out.forEach((row, p) => {
        const j = row[k];
        if (j < 0) return;
        const q = owner.get(j);
        if (q === undefined) { owner.set(j, p); return; }
        if (distance[p][k] < distance[q][k]) { out[q][k] = -1; owner.set(j, p); } else out[p][k] = -1;
      });
    }
    return out;
  },

  /** One pass over the frames, forward or backward in time: per player and frame the box taken, or -1. */
  pass(frames: readonly PictureFrame[], keysOf: readonly (readonly PictureKey[])[], forward: boolean, s: PictureTrackerSettings,
    allowed?: (player: number, frame: number, box: PersonBox) => boolean): number[][] {
    const n = frames.length;
    const out = keysOf.map(() => new Array<number>(n).fill(-1));
    const players: (Follower | undefined)[] = keysOf.map(() => undefined);
    let passing: Follower[] = [];
    const forbidden = 1e9;
    for (let step = 0; step < n; step++) {
      const k = forward ? step : n - 1 - step;
      const t = frames[k].time, boxes = frames[k].people;
      const taken = new Array<boolean>(boxes.length).fill(false);
      // Keys first: the player is where the coach tapped them.
      const keyed = new Set<number>();
      keysOf.forEach((keys, p) => {
        const key = keys.find((q) => q.frame === k);
        if (!key || key.box < 0 || key.box >= boxes.length) return;
        players[p] = new Follower(boxes[key.box], t);
        out[p][k] = key.box;
        taken[key.box] = true;
        keyed.add(p);
      });
      passing = passing.filter((f) => Math.abs(t - f.time) <= s.passingCoast);
      const rows: { follower: Follower; player: number }[] = [
        ...players.flatMap((f, p) => (f && !keyed.has(p) ? [{ follower: f, player: p }] : [])),
        ...passing.map((f) => ({ follower: f, player: -1 })),
      ];
      const free = boxes.flatMap((b, j) => (taken[j] ? [] : [j]));
      const nt = rows.length, nd = free.length;
      const assigned = new Array<boolean>(boxes.length).fill(false);
      if (nt > 0 && nd > 0) {
        const cost = Array.from({ length: nt + nd }, () => new Array<number>(nd + nt).fill(forbidden));
        for (let j = 0; j < nd; j++) cost[nt + j][j] = 0;
        for (let i = nt; i < nt + nd; i++) for (let j = nd; j < nd + nt; j++) cost[i][j] = 0;
        rows.forEach(({ follower: f, player }, i) => {
          cost[i][nd + i] = s.missCost;
          const dt = Math.abs(t - f.time), lead = Math.min(dt, s.lead);
          const px = f.x + f.vx * lead, py = f.y + f.vy * lead;
          const reach = Math.min(s.maxReach, s.reach + s.speed * dt), sigma = s.sigma + s.sigmaGrowth * dt;
          free.forEach((j, c) => {
            const b = boxes[j];
            if (player >= 0 && allowed && !allowed(player, k, b)) return;
            const a = anchorOf(b);
            const d = Math.hypot(a.x - px, a.y - py) / Math.max(f.h, 1);
            if (!(d <= reach)) return;
            const size = Math.log(Math.max(b.h, 1) / Math.max(f.h, 1));
            let colour = 0;
            if (f.appearance && b.appearance && f.appearance.length === b.appearance.length) {
              for (let m = 0; m < b.appearance.length; m++) colour += (f.appearance[m] - b.appearance[m]) ** 2;
            }
            cost[i][c] = (d / sigma) ** 2 + 2 * Math.log(sigma / s.sigma) + s.sizeWeight * size * size + s.appearanceWeight * colour;
          });
        });
        Hungarian.solve(cost).forEach((c, i) => {
          if (i >= nt || c === undefined || c >= nd || !(cost[i][c] < forbidden)) return;
          const j = free[c], row = rows[i];
          row.follower.take(boxes[j], t);
          if (row.player >= 0) out[row.player][k] = j;
          assigned[j] = true;
        });
      }
      // Everyone else starts a passing track (a second box on someone already followed does not).
      const held = boxes.filter((_, j) => assigned[j] || taken[j]);
      free.forEach((j) => {
        if (assigned[j] || held.some((h) => boxOverlap(h, boxes[j]) > 0.5)) return;
        passing.push(new Follower(boxes[j], t));
      });
    }
    return out;
  },
};
