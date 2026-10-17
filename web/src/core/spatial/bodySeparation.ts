// Bodies that never pass through each other. Web addition (no Swift counterpart): every posed player as a set of
// capsules that encloses the avatar mesh (AvatarMesh in skeleton.ts), and a solver that slides whole bodies apart on
// the floor until no two overlap and no trunk or head reaches through the net. Positions from a video or from the
// rally autopilot are only as good as their source; two people cannot stand in one spot, so the 3D view and the
// eye-view analysis use the separated bodies.
import type { FloorPoint } from "../match/court";
import { Rigid, V3 } from "./math3d";
import { athleteCapsules, type AthleteRig } from "./athleteBody";
import { athleteRig } from "./athleteRigs";
import { PlayerBodies, PosedPlayer } from "./povAnalysis";
import { BodyMetrics, Joint, SkeletonModel, type Posture } from "./skeleton";

/** A segment swept by a sphere: every point within `r` of the segment from `a` to `b`. */
export interface BodyCapsule {
  a: V3;
  b: V3;
  r: number;
  /** Trunk, neck or head: the parts that may never reach through the net. */
  core: boolean;
}

/**
 * The capsules of a posed body, in world metres. Each one is the rest-pose geometry of the avatar mesh carried by the
 * skin transform of the joint that drives it, with radii a little larger than the mesh's (its tubes, bulges and caps
 * included), so bodies whose capsules do not overlap do not overlap on screen either.
 */
export function bodyCapsules(skeleton: SkeletonModel, posed: readonly Rigid[]): BodyCapsule[] {
  const rest = skeleton.restPose;
  const h = skeleton.metrics.stature;
  const at = (j: Joint, dx = 0, dy = 0, dz = 0): V3 =>
    posed[j].mul(rest[j].inverse).apply(rest[j].translation.add(new V3(dx * h, dy * h, dz * h)));
  const seg = (a: V3, b: V3, r: number, core = false): BodyCapsule => ({ a, b, r: r * h, core });
  const out: BodyCapsule[] = [];
  // The trunk is wider than deep: two capsules side by side for each part of it, each carried by the joint that
  // drives that part of the mesh (shorts by the pelvis, the jersey by the spine bending into the chest, the chest).
  const by = (driver: Joint, of: Joint, dx = 0, dy = 0): V3 =>
    posed[driver].mul(rest[driver].inverse).apply(rest[of].translation.add(new V3(dx * h, dy * h, 0)));
  // Offsets and radii cover the mesh's elliptical sections, middle included: below the chest half-width 0.104 H and
  // half-depth 0.07 H, the chest 0.116 H by 0.07 H (offset a, radius r with a + r >= width, r^2 - a^2 >= depth^2).
  for (const s of [-1, 1]) {
    const w = 0.029 * s, c = 0.038 * s;
    out.push(seg(by(Joint.pelvis, Joint.pelvis, w, -0.06), by(Joint.pelvis, Joint.pelvis, w, 0.045), 0.078, true));
    out.push(seg(by(Joint.spine, Joint.pelvis, w, 0.03), by(Joint.spine, Joint.chest, w), 0.078, true));
    out.push(seg(by(Joint.spine, Joint.chest, w), by(Joint.chest, Joint.chest, w), 0.078, true));
    out.push(seg(by(Joint.chest, Joint.chest, c, -0.02), by(Joint.chest, Joint.neck, c, -0.035), 0.08, true));
  }
  out.push(seg(at(Joint.neck), at(Joint.head, 0, 0.025), 0.04, true));
  const head = at(Joint.head, 0, 0.06, 0.01);
  out.push(seg(head, head, 0.068, true));
  for (const left of [true, false]) {
    const sh = left ? Joint.lShoulder : Joint.rShoulder, el = left ? Joint.lElbow : Joint.rElbow, wr = left ? Joint.lWrist : Joint.rWrist;
    const hip = left ? Joint.lHip : Joint.rHip, kn = left ? Joint.lKnee : Joint.rKnee, an = left ? Joint.lAnkle : Joint.rAnkle;
    out.push(seg(at(sh), at(el), 0.038), seg(at(el), at(wr), 0.028), seg(at(wr), at(wr, 0, -skeleton.handLength / h), 0.027));
    out.push(seg(at(hip), at(kn), 0.066), seg(at(kn), at(an), 0.045), seg(at(an, 0, -0.024, -0.032), at(an, 0, -0.03, 0.118), 0.028));
  }
  return out;
}

/**
 * The capsules of a posed player's body as drawn: the athlete's (PlayerBodies.athletes, women or men) or the
 * mannequin's.
 */
export function playerCapsules(p: PosedPlayer): BodyCapsule[] {
  // A player taking steps: the whole step cycle (its turning points, a centimetre thicker for the arcs between them), so
  // swinging arms and legs never reach into anyone. The trunk does not swing (once is enough), the arms swing between
  // the second and fourth turning points through the first.
  const envelope = p.strideEnvelope;
  if (envelope.length > 0) {
    const kinds = PlayerBodies.athletes ? athleteCapsuleKinds(athleteRig(PlayerBodies.women)) : undefined;
    const out: BodyCapsule[] = [];
    envelope.forEach((joints, k) => {
      playerCapsules(new PosedPlayer(p.token, p.skeleton, joints)).forEach((c, i) => {
        const kind = kinds?.[i] ?? "leg";
        if ((kind === "trunk" && k > 0) || (kind === "arm" && k === 2)) return;
        out.push({ ...c, r: c.r + 0.01 });
      });
    });
    return out;
  }
  return PlayerBodies.athletes ? athleteCapsules(athleteRig(PlayerBodies.women), p) : bodyCapsules(p.skeleton, p.joints);
}

const capsuleKinds = new WeakMap<AthleteRig, ("trunk" | "arm" | "leg")[]>();

/** Which part of the body each of an athlete's capsules belongs to (by the bone carrying its first end). */
function athleteCapsuleKinds(rig: AthleteRig): ("trunk" | "arm" | "leg")[] {
  let kinds = capsuleKinds.get(rig);
  if (!kinds) {
    kinds = rig.capsules.map((c) => {
      const bone = rig.bones[c.a.bone].name;
      return /^(clavicle|upperarm|lowerarm|hand)_/.test(bone) ? "arm" : /^(thigh|calf|foot|ball)_/.test(bone) ? "leg" : "trunk";
    });
    capsuleKinds.set(rig, kinds);
  }
  return kinds;
}

/** Closest points of segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9): parameters s, t. */
function closest(p1: V3, q1: V3, p2: V3, q2: V3): { s: number; t: number; d2: number } {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  const eps = 1e-12;
  let s = 0, t = 0;
  if (a <= eps && e <= eps) { s = 0; t = 0; } else if (a <= eps) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= eps) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > eps ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const x = rx + d1x * s - d2x * t, y = ry + d1y * s - d2y * t, z = rz + d1z * s - d2z * t;
  return { s, t, d2: x * x + y * y + z * z };
}

/** Capsules as flat numbers for the solver: ax ay az bx by bz r, then the floor box (min x, max x, min z, max z). */
const stride = 11;

function packed(caps: readonly BodyCapsule[]): Float64Array {
  const out = new Float64Array(caps.length * stride);
  caps.forEach((k, i) => {
    const o = i * stride;
    out.set([k.a.x, k.a.y, k.a.z, k.b.x, k.b.y, k.b.z, k.r,
      Math.min(k.a.x, k.b.x) - k.r, Math.max(k.a.x, k.b.x) + k.r, Math.min(k.a.z, k.b.z) - k.r, Math.max(k.a.z, k.b.z) + k.r], o);
  });
  return out;
}

/**
 * How deep two bodies overlap when B is shifted by (ox, oz) on the floor: the largest (rA + rB + margin - distance)
 * over all capsule pairs; zero or less means they are apart by at least the margin.
 */
function depthAt(A: Float64Array, B: Float64Array, ox: number, oz: number, margin: number): number {
  let worst = -Infinity;
  for (let i = 0; i < A.length; i += stride) {
    const ra = A[i + 6];
    for (let j = 0; j < B.length; j += stride) {
      const reach = ra + B[j + 6] + margin;
      // Floor boxes apart by more than the margin: these two cannot touch.
      if (B[j + 7] + ox > A[i + 8] + margin || B[j + 8] + ox < A[i + 7] - margin
        || B[j + 9] + oz > A[i + 10] + margin || B[j + 10] + oz < A[i + 9] - margin) {
        worst = Math.max(worst, -margin);
        continue;
      }
      const c = closest(
        new V3(A[i], A[i + 1], A[i + 2]), new V3(A[i + 3], A[i + 4], A[i + 5]),
        new V3(B[j] + ox, B[j + 1], B[j + 2] + oz), new V3(B[j + 3] + ox, B[j + 4], B[j + 5] + oz));
      worst = Math.max(worst, reach - Math.sqrt(c.d2));
    }
  }
  return worst;
}

/** Whether two bodies are apart by at least the margin when B is shifted by (ox, oz): depthAt <= 0, stopping at the first touch. */
function apartAt(A: Float64Array, B: Float64Array, ox: number, oz: number, margin: number): boolean {
  for (let i = 0; i < A.length; i += stride) {
    const ra = A[i + 6];
    for (let j = 0; j < B.length; j += stride) {
      if (B[j + 7] + ox > A[i + 8] + margin || B[j + 8] + ox < A[i + 7] - margin
        || B[j + 9] + oz > A[i + 10] + margin || B[j + 10] + oz < A[i + 9] - margin) continue;
      const c = closest(
        new V3(A[i], A[i + 1], A[i + 2]), new V3(A[i + 3], A[i + 4], A[i + 5]),
        new V3(B[j] + ox, B[j + 1], B[j + 2] + oz), new V3(B[j + 3] + ox, B[j + 4], B[j + 5] + oz));
      const reach = ra + B[j + 6] + margin;
      if (c.d2 < reach * reach) return false;
    }
  }
  return true;
}

/** Horizontal reach of a body's capsules from its pelvis (for skipping pairs that cannot touch). */
function reachOf(caps: readonly BodyCapsule[], c: V3): number {
  let r = 0;
  for (const k of caps) for (const p of [k.a, k.b]) r = Math.max(r, Math.hypot(p.x - c.x, p.z - c.z) + k.r);
  return r;
}

const postureReaches = new Map<string, number>();

/**
 * How far a body in a posture reaches out on the floor from its pelvis (arms, legs and stance included), metres: two
 * players at least the sum of their reaches apart cannot touch, however they face.
 */
export function postureReach(posture: Posture, stature = 1.85): number {
  const key = `${posture}|${stature.toFixed(3)}|${PlayerBodies.athletes}|${PlayerBodies.women}`;
  let r = postureReaches.get(key);
  if (r === undefined) {
    const s = new SkeletonModel(new BodyMetrics(stature));
    const joints = s.pose(posture, { x: 0, z: 0 }, 0);
    const token = { id: "reach", side: "home" as const, label: "", role: "", point: { x: 0, z: 0 } };
    r = reachOf(playerCapsules(new PosedPlayer(token, s, joints)), joints[Joint.pelvis].translation);
    postureReaches.set(key, r);
  }
  return r;
}

export interface SeparationOptions {
  /** How readily a player gives way (default 1; 0 stands firm, e.g. the player the coach is dragging). */
  weight?: (p: PosedPlayer) => number;
  /**
   * Each player's floor velocity, metres per second. Players closing in on each other then step aside across their
   * paths and pass, instead of being pushed back along them (which would make them jump when their paths cross).
   */
  velocity?: (p: PosedPlayer) => FloorPoint | undefined;
  /** Clearance kept between bodies and from the net plane, metres (default 1 cm). */
  margin?: number;
  /**
   * Seconds of look-ahead: two players closing in at speed v keep v times this much extra room (at most a quarter metre),
   * so they start to step aside before they meet (default 0: only bodies that touch move).
   */
  anticipation?: number;
  /**
   * Passing, for a track (which sees the paths ahead): teammates whose paths run at each other (from 0.5 m/s closing)
   * drift apart across them, smoothly over the last `time` seconds before they are within reach, until their bodies
   * clear each other side by side (at most `width` metres apart; see `relax`).
   */
  passing?: { width: number; time: number };
}

/** Clearance teammates passing each other keep between their bodies, metres. */
const passingRoom = 0.05;
/** How fast the room for a pass opens at most, metres per second. */
const passingRate = 4;

/** Half the net's length plus the posts: within it, trunks and heads stay on their own side of the net plane. */
const netHalfLength = 5.5;

/**
 * How far a body's trunk and head stay clear of the net plane on their own side (negative: reaching through), metres;
 * undefined beyond the posts, where there is no net. Home stands at +Z, the opponent at -Z.
 */
function netClearance(p: PosedPlayer, caps: readonly BodyCapsule[]): number | undefined {
  if (Math.abs(p.joints[Joint.pelvis].translation.x) > netHalfLength) return undefined;
  let clear = Infinity;
  for (const k of caps) {
    if (!k.core) continue;
    clear = Math.min(clear, p.token.side === "home" ? Math.min(k.a.z, k.b.z) - k.r : -Math.max(k.a.z, k.b.z) - k.r);
  }
  return clear;
}

type Offsets = Map<string, FloorPoint>;

/** Where the players will stand on their own paths: their floor points `tau[k]` seconds from now (`tau[0]` = 0). */
interface Ahead {
  tau: number[];
  points: ReadonlyMap<string, FloorPoint>[];
}

/**
 * Slides bodies apart on the floor (whole bodies, poses unchanged), starting from `start` offsets: until no two bodies
 * overlap and no trunk or head reaches through the net. Each touching pair moves apart just far enough along the line
 * between their pelvises; when they are running into each other it leans sideways, so they slide past each other on
 * the side they were already drifting to instead of pushing head-on. The push is shared by their weights, and a
 * player held by the net passes its share on. Returns the offset of every player.
 */
function relax(players: readonly PosedPlayer[], start: Offsets | undefined,
  options: SeparationOptions & { ahead?: Ahead; elapsed?: number },
  sides?: Map<string, number>): Offsets {
  const n = players.length;
  const met = new Set<string>();
  const margin = options.margin ?? 0.01;
  const anticipation = options.anticipation ?? 0;
  const caps = players.map(playerCapsules);
  const flat = caps.map(packed);
  const centre = players.map((p) => p.joints[Joint.pelvis].translation);
  const reach = caps.map((c, i) => reachOf(c, centre[i]));
  const weight = players.map((p) => Math.max(0, options.weight?.(p) ?? 1));
  const velocity = players.map((p) => options.velocity?.(p));
  const dx = players.map((p) => start?.get(p.id)?.x ?? 0), dz = players.map((p) => start?.get(p.id)?.z ?? 0);
  // Within the posts, how far each body may move toward the net (moving along the net does not change it):
  // home keeps dz >= low, the opponent dz <= high.
  const net = players.map((p, i) => netClearance(p, caps[i]));
  const low = players.map((p, i) => (net[i] === undefined || p.token.side !== "home" ? -Infinity : margin - net[i]!));
  const high = players.map((p, i) => (net[i] === undefined || p.token.side === "home" ? Infinity : net[i]! - margin));
  const clampZ = (i: number) => { dz[i] = Math.min(high[i], Math.max(low[i], dz[i])); };
  for (let i = 0; i < n; i++) clampZ(i);

  // Passing (a track only): teammates whose paths would run through each other drift apart across their paths,
  // smoothly, so that by the time they are within reach of each other their bodies clear each other side by side; once
  // past each other they ease back onto their paths.
  const passing = options.passing, ahead = options.ahead;
  if (passing && ahead && ahead.tau.length > 1) {
    // Each player's path ahead, shifted to their pelvis as it stands now.
    const paths = players.map((p, i) => {
      const lx = centre[i].x - p.token.point.x, lz = centre[i].z - p.token.point.z;
      return ahead.points.map((m) => { const q = m.get(p.id) ?? p.token.point; return { x: q.x + lx, z: q.z + lz }; });
    });
    const tau = ahead.tau;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (players[i].token.side !== players[j].token.side) continue;
        // Follow j as seen from i along their paths (with today's offsets) for as long as they close in.
        const Pi = paths[i], Pj = paths[j], ox = dx[j] - dx[i], oz = dz[j] - dz[i];
        let k = 0, rx = Pj[0].x - Pi[0].x + ox, rz = Pj[0].z - Pi[0].z + oz, dist = Math.hypot(rx, rz);
        let travelled = 0, mx = 0, mz = 0;
        const covered = [0];
        while (k + 1 < tau.length) {
          const nx = Pj[k + 1].x - Pi[k + 1].x + ox, nz = Pj[k + 1].z - Pi[k + 1].z + oz, nd = Math.hypot(nx, nz);
          if (nd >= dist) break;
          mx = nx - rx; mz = nz - rz;
          travelled += Math.hypot(mx, mz);
          covered.push(travelled);
          rx = nx; rz = nz; dist = nd; k++;
        }
        // Only pairs still coming at each other; once past each other they need no room made for them (they move
        // apart) and ease back onto their paths.
        if (k === 0) continue;
        const ml = Math.hypot(mx, mz);
        if (ml < 1e-9) continue;
        // Where they come closest: how far across j then passes i, and how far they still have to go to get there.
        const ux = mx / ml, uz = mz / ml, tx = -uz, tz = ux;
        const across = rx * tx + rz * tz;
        const toGo = travelled + Math.max(0, -(rx * ux + rz * uz));
        const speed = travelled / tau[k];
        // Players walking keep only from touching; from a slow run (0.5 to 1.5 m/s closing) they pass ever wider apart.
        const pace = Math.min(1, Math.max(0, (speed - 0.5) / 1));
        if (pace <= 0) continue;
        const key = players[i].id < players[j].id ? `${players[i].id}|${players[j].id}` : `${players[j].id}|${players[i].id}`;
        // The side of a pass is kept only while the pair is passing (see the end): the next pass starts from where they are.
        const passKey = `${key}|pass`;
        // Fully apart while within reach of each other (arms held forward meet before the bodies do), easing in over the
        // last `passing.time` seconds before they get there (timed along their paths, so a player still speeding up
        // is not met late).
        const reachBoth = Math.min(1.6, reach[i] + reach[j]);
        let reachAt = 0;
        if (toGo > reachBoth) {
          let q = 1;
          while (q <= k && toGo - covered[q] > reachBoth) q++;
          if (q <= k) {
            const before = toGo - covered[q - 1], after = toGo - covered[q];
            reachAt = tau[q - 1] + ((before - reachBoth) / (before - after)) * (tau[q] - tau[q - 1]);
          } else {
            // Within reach only past the closest sample: at the pace of the last step.
            reachAt = tau[k] + (toGo - travelled - reachBoth) / Math.max(0.1, ml / (tau[k] - tau[k - 1]));
          }
        }
        if (reachAt >= passing.time || Math.abs(across) >= passing.width) continue;
        const x = 1 - reachAt / passing.time;
        const vi = velocity[i], vj = velocity[j];
        const flip = players[i].id < players[j].id ? 1 : -1;
        let side = sides?.has(passKey) ? sides.get(passKey)! * flip : undefined;
        if (side === undefined) {
          // Starting to pass (no room wanted yet): on the side they are already apart to, else the side they last chose.
          const kept = sides?.get(key);
          side = Math.abs(across) > 0.02 ? Math.sign(across)
            : kept !== undefined ? kept * flip : passingSide(players[i], players[j], vi, vj, 0, 0, tx, tz);
          sides?.set(passKey, side * flip);
          sides?.set(key, side * flip);
        }
        met.add(passKey);
        met.add(key);
        // The room they need: how far apart across their bodies, as posed now, clear each other side by side (at most
        // `passing.width`); players who would miss each other anyway keep to their paths.
        const Rx = centre[j].x - centre[i].x, Rz = centre[j].z - centre[i].z;
        const clearAt = (d: number) => apartAt(flat[i], flat[j], d * side! * tx - Rx, d * side! * tz - Rz, margin + passingRoom);
        // Already that far apart across (the usual case): no more is needed, and that is all the room needs to know.
        const apart = side * across;
        let need = Math.max(0, Math.min(passing.width, apart));
        if (!clearAt(need)) {
          let lo = need, hi = passing.width;
          if (clearAt(hi)) {
            while (hi - lo > 0.01) {
              const mid = (lo + hi) / 2;
              if (clearAt(mid)) hi = mid; else lo = mid;
            }
          }
          need = hi;
        }
        // The room opens no faster than `passingRate` (a pass that comes into view all at once, say a player starting
        // to walk toward a teammate standing close by, eases open instead of pushing them apart in one frame).
        const wantKey = `${key}|want`;
        const opened = sides?.get(wantKey) ?? 0;
        const want = Math.min(opened + passingRate * (options.elapsed ?? Infinity),
          need * pace * pace * (3 - 2 * pace) * x * x * (3 - 2 * x));
        sides?.set(wantKey, want);
        met.add(wantKey);
        if (want <= 0) continue;
        const deficit = want - apart;
        if (deficit <= 0) continue;
        let wi = weight[i], wj = weight[j];
        if (wi + wj <= 0) { wi = 1; wj = 1; }
        const si = wi / (wi + wj), sj = 1 - si;
        const zi = dz[i] - side * tz * deficit * si;
        dx[i] -= side * tx * deficit * si;
        dz[i] = zi;
        clampZ(i);
        const zj = dz[j] + side * tz * deficit * sj + (dz[i] - zi);
        dx[j] += side * tx * deficit * sj;
        dz[j] = zj;
        clampZ(j);
        if (dz[j] !== zj) { dz[i] += dz[j] - zj; clampZ(i); }
      }
    }
  }

  for (let iteration = 0; iteration < 40; iteration++) {
    let touching = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const rx = centre[j].x + dx[j] - centre[i].x - dx[i], rz = centre[j].z + dz[j] - centre[i].z - dz[i];
        const dist = Math.hypot(rx, rz);
        // Apart along the line between the pelvises (exactly on top of each other: along the net).
        const nx = dist > 1e-6 ? rx / dist : 1, nz = dist > 1e-6 ? rz / dist : 0;
        const vi = velocity[i], vj = velocity[j];
        const vx = (vj?.x ?? 0) - (vi?.x ?? 0), vz = (vj?.z ?? 0) - (vi?.z ?? 0);
        // Across the net only touching counts (hands over the net): the net keeps their bodies apart.
        const teammates = players[i].token.side === players[j].token.side;
        const closing = teammates ? -(vx * nx + vz * nz) : 0;
        // Teammates running at each other keep more room, so they start to give way before they touch.
        const room = margin + Math.min(0.25, anticipation * Math.max(0, closing));
        if (dist >= reach[i] + reach[j] + room) continue;
        const ox = dx[j] - dx[i], oz = dz[j] - dz[i];
        if (apartAt(flat[i], flat[j], ox, oz, room)) continue;
        touching = true;
        let ux = nx, uz = nz;
        if (closing > 0) {
          // Sideways: j passes i on the side kept for this pair, chosen when they first meet.
          const tx = -nz, tz = nx;
          // The kept side is stored across the relative motion (see passing); closing in, that axis is the opposite of t.
          const key = players[i].id < players[j].id ? `${players[i].id}|${players[j].id}` : `${players[j].id}|${players[i].id}`;
          const flip = players[i].id < players[j].id ? 1 : -1;
          const speed = Math.hypot(vx, vz);
          const toMotion = speed > 1e-9 && (tx * -vz + tz * vx) / speed < 0 ? -1 : 1;
          const kept = sides?.get(`${key}|pass`) ?? sides?.get(key);
          let side: number;
          if (kept === undefined) {
            side = passingSide(players[i], players[j], vi, vj, vx, vz, tx, tz);
            sides?.set(key, side * toMotion * flip);
          } else side = kept * flip * toMotion;
          met.add(key);
          const lean = Math.min(1, closing / 0.8);
          const bx = nx + lean * side * tx, bz = nz + lean * side * tz;
          const l = Math.hypot(bx, bz);
          ux = bx / l;
          uz = bz / l;
        }
        // The smallest move along u that clears them: double until clear, then halve the bracket.
        const clearAt = (s: number) => apartAt(flat[i], flat[j], ox + s * ux, oz + s * uz, room);
        let lo = 0, hi = 0.02;
        while (!clearAt(hi) && hi < 4) { lo = hi; hi *= 2; }
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          if (clearAt(mid)) hi = mid; else lo = mid;
        }
        let wi = weight[i], wj = weight[j];
        if (wi + wj <= 0) { wi = 1; wj = 1; }
        const si = wi / (wi + wj), sj = 1 - si;
        // i moves back, j forward; what the net takes from one, the other makes up.
        const zi = dz[i] - uz * hi * si;
        dx[i] -= ux * hi * si;
        dz[i] = zi;
        clampZ(i);
        const zj = dz[j] + uz * hi * sj + (dz[i] - zi);
        dx[j] += ux * hi * sj;
        dz[j] = zj;
        clampZ(j);
        if (dz[j] !== zj) { dz[i] += dz[j] - zj; clampZ(i); }
      }
    }
    if (!touching) break;
  }
  // Pairs no longer passing start their next pass afresh; pairs well apart again choose afresh next time they meet.
  if (sides) {
    const at = new Map(players.map((p, i) => [p.id, i]));
    for (const key of [...sides.keys()]) {
      if (met.has(key)) continue;
      if (key.endsWith("|pass") || key.endsWith("|want")) { sides.delete(key); continue; }
      const [a, b] = key.split("|").map((id) => at.get(id));
      if (a === undefined || b === undefined) { sides.delete(key); continue; }
      const gap = Math.hypot(centre[b].x + dx[b] - centre[a].x - dx[a], centre[b].z + dz[b] - centre[a].z - dz[a]);
      if (gap > reach[a] + reach[b] + 0.2) sides.delete(key);
    }
  }
  return new Map(players.map((p, i) => [p.id, { x: dx[i], z: dz[i] }]));
}

/**
 * Which way j passes i (+1: along t = n turned left, -1: right) when they run into each other: the way j already
 * drifts past i; straight at each other, teammates pass with the faster one going round the back, away from the net
 * (as players do when they switch); otherwise j keeps to its left.
 */
function passingSide(pi: PosedPlayer, pj: PosedPlayer, vi: FloorPoint | undefined, vj: FloorPoint | undefined,
  vx: number, vz: number, tx: number, tz: number): number {
  const speed = Math.hypot(vx, vz);
  const drift = vx * tx + vz * tz;
  if (Math.abs(drift) > 0.3 * speed) return drift > 0 ? 1 : -1;
  if (pi.token.side === pj.token.side && Math.abs(tz) > 0.2) {
    const away = pi.token.side === "home" ? 1 : -1;
    const si = Math.hypot(vi?.x ?? 0, vi?.z ?? 0), sj = Math.hypot(vj?.x ?? 0, vj?.z ?? 0);
    const want = Math.sign(tz * away);
    return sj >= si ? want : -want;
  }
  return 1;
}

/** The players moved by their offsets (whole bodies on the floor); players that do not move are returned as they came. */
export function offsetBodies(players: readonly PosedPlayer[], offsets: ReadonlyMap<string, FloorPoint>): PosedPlayer[] {
  return players.map((p) => {
    const o = offsets.get(p.id);
    if (!o || (Math.abs(o.x) < 1e-9 && Math.abs(o.z) < 1e-9)) return p;
    const shift = new V3(o.x, 0, o.z);
    const move = (joints: readonly Rigid[]) => joints.map((r) => new Rigid(r.rotation, r.translation.add(shift)));
    const token = { ...p.token, point: { x: p.token.point.x + o.x, z: p.token.point.z + o.z } };
    return new PosedPlayer(token, p.skeleton, move(p.joints), p.strideEnvelope.map(move));
  });
}

/**
 * The players of one moment slid apart (see `relax`), from where they stand, or from `start` offsets (a nearby
 * moment's solution). For a single moment; for moving players use a `SeparationTrack`, which keeps them from jumping.
 */
export function separateBodies(players: readonly PosedPlayer[], options: SeparationOptions = {}, start?: ReadonlyMap<string, FloorPoint>): PosedPlayer[] {
  if (players.length === 0) return [];
  return offsetBodies(players, separationOffsets(players, options, start));
}

/** How far `separateBodies` slides each player (for applying the same slide to the players posed otherwise). */
export function separationOffsets(players: readonly PosedPlayer[], options: SeparationOptions = {},
  start?: ReadonlyMap<string, FloorPoint>): Map<string, FloorPoint> {
  return players.length === 0 ? new Map() : relax(players, start as Offsets | undefined, options);
}

/** One moment of a rally for a `SeparationTrack`: the players as posed and their floor velocities (m/s). */
export interface SeparationMoment {
  players: PosedPlayer[];
  velocity: ReadonlyMap<string, FloorPoint>;
  /** How readily each player gives way (default 1). */
  weight?: (p: PosedPlayer) => number;
}

export interface SeparationTrackOptions {
  margin?: number;
  /** Seconds in which a sidestep eases back onto the player's own path once there is room (default 0.5). */
  relaxTime?: number;
  /** Nobody moves more than this between two solved moments, metres (default 5 cm). */
  stepDistance?: number;
  /** Bounds of the step between solved moments, seconds (default 1/240 to 1/15). */
  minStep?: number;
  maxStep?: number;
  /** Look-ahead when players run at each other, seconds (default 0: passing takes care of it). */
  anticipation?: number;
  /** How teammates pass each other (default: easing over the last 0.6 s, to at most 1.2 m apart across). */
  passing?: { width: number; time: number };
  /** Seconds either side over which `offsets` averages the solved moments (default 0.1; 0 reads them as solved). */
  smoothing?: number;
  /**
   * Where every player stands on their own path at time t (cheap: positions only); used to see who will pass whom over
   * the next second. Default: the players of `moment(t)`.
   */
  floor?: (t: number) => ReadonlyMap<string, FloorPoint>;
}

/** How far ahead a track looks for players about to pass each other, and in what steps, seconds. */
const lookAhead = 1;
const lookStep = 0.05;

/**
 * How far every player is slid aside through a rally (seconds `start` to `end`), solved moment by moment from the
 * start: each moment begins from the last one's offsets, eased back toward the player's own path, and adds only what
 * the bodies need there. Moments are close enough that nobody moves more than a few centimetres between them, so
 * players step around each other smoothly instead of jumping, and the same time always gives the same picture.
 * Moments are solved as they are first asked for (playback runs forward); `offsets(t)` interpolates between them.
 */
export class SeparationTrack {
  private readonly times: number[] = [];
  private readonly solved: Offsets[] = [];
  /** Per pair: the side chosen when they met (kept until they are well apart); while passing, the room opened so far. */
  private readonly sides = new Map<string, number>();
  private readonly o: Required<SeparationTrackOptions>;
  /** The players' floor points on the look-ahead grid (index k: time k * lookStep), from the current moment on. */
  private readonly grid = new Map<number, ReadonlyMap<string, FloorPoint>>();

  constructor(private readonly moment: (t: number) => SeparationMoment, readonly start: number, readonly end: number,
    options: SeparationTrackOptions = {}) {
    this.o = { margin: options.margin ?? 0.01, relaxTime: options.relaxTime ?? 0.5, stepDistance: options.stepDistance ?? 0.05,
      minStep: options.minStep ?? 1 / 240, maxStep: options.maxStep ?? 1 / 15, anticipation: options.anticipation ?? 0,
      passing: options.passing ?? { width: 1.2, time: 0.6 }, smoothing: options.smoothing ?? 0.1,
      floor: options.floor ?? ((t) => new Map(moment(t).players.map((p) => [p.id, p.token.point]))) };
  }

  /** The players' paths over the next second from a moment (held at the end of the rally). */
  private ahead(time: number, m: SeparationMoment): Ahead {
    const first = Math.floor(time / lookStep) + 1;
    for (const k of this.grid.keys()) if (k < first) this.grid.delete(k);
    const tau = [0];
    const points: ReadonlyMap<string, FloorPoint>[] = [new Map(m.players.map((p) => [p.id, p.token.point]))];
    for (let k = first; k * lookStep <= time + lookAhead + 1e-9; k++) {
      let at = this.grid.get(k);
      if (!at) {
        at = this.o.floor(Math.min(this.end, k * lookStep));
        this.grid.set(k, at);
      }
      tau.push(k * lookStep - time);
      points.push(at);
    }
    return { tau, points };
  }

  /** How many moments are solved so far. */
  get solvedCount(): number {
    return this.times.length;
  }

  private preparing?: ReturnType<typeof setTimeout>;
  private stopped = false;

  /**
   * Solves the rest of the rally in the background, `budget` milliseconds at a time, so playback finds it ready (web
   * apps only: it runs on timers). `stop` ends it, for a track no longer shown.
   */
  prepare(budget = 6): void {
    if (this.preparing !== undefined || this.stopped) return;
    const pump = () => {
      const start = performance.now();
      while (!this.stopped && performance.now() - start < budget && !this.complete) {
        this.extend((this.times.length ? this.times[this.times.length - 1] : this.start) + 0.02);
      }
      this.preparing = this.stopped || this.complete ? undefined : setTimeout(pump, 16);
    };
    this.preparing = setTimeout(pump, 0);
  }

  /** Stops solving ahead in the background. */
  stop(): void {
    this.stopped = true;
    if (this.preparing !== undefined) clearTimeout(this.preparing);
    this.preparing = undefined;
  }

  private get complete(): boolean {
    return this.times.length > 0 && this.times[this.times.length - 1] >= this.end - 1e-9;
  }

  /** Solves moments until time t is covered. */
  private extend(t: number) {
    const target = Math.min(t, this.end);
    while (this.times.length === 0 || this.times[this.times.length - 1] < target - 1e-9) {
      const k = this.times.length;
      let time: number, start: Offsets | undefined, m: SeparationMoment;
      if (k === 0) {
        time = this.start;
        m = this.moment(time);
      } else {
        const last = this.times[k - 1];
        const lm = this.lastMoment!;
        let vmax = 0;
        for (const v of lm.velocity.values()) vmax = Math.max(vmax, Math.hypot(v.x, v.z));
        const step = Math.min(this.o.maxStep, Math.max(this.o.minStep, this.o.stepDistance / Math.max(vmax, 1e-6)));
        time = Math.min(this.end, last + step);
        m = this.moment(time);
        const keep = Math.exp(-(time - last) / this.o.relaxTime);
        start = new Map([...this.solved[k - 1]].map(([id, q]) => [id, { x: q.x * keep, z: q.z * keep }]));
      }
      this.solved.push(relax(m.players, start, { margin: this.o.margin, anticipation: this.o.anticipation, weight: m.weight,
        velocity: (p) => m.velocity.get(p.id), passing: this.o.passing, ahead: this.ahead(time, m),
        elapsed: k === 0 ? undefined : time - this.times[k - 1] }, this.sides));
      this.times.push(time);
      this.lastMoment = m;
      if (time >= this.end - 1e-9) break;
    }
  }
  private lastMoment?: SeparationMoment;

  /**
   * Every player's offset at time t: the solved moments averaged over `smoothing` seconds either side (weighted toward
   * t), so a quick step aside is spread over a few frames instead of showing in one. A touch the averaging lets
   * through is for the moment's own separation to clear (`separateBodies` starting from these offsets).
   */
  offsets(t: number): Map<string, FloorPoint> {
    const h = this.o.smoothing;
    if (!(h > 0)) return this.at(t);
    this.extend(t + h);
    const out = new Map<string, FloorPoint>();
    let total = 0;
    const steps = 8;
    for (let k = 1; k < steps; k++) {
      const w = 1 - Math.abs((2 * k) / steps - 1);
      const sample = this.at(t - h + (2 * h * k) / steps);
      for (const [id, q] of sample) {
        const o = out.get(id) ?? { x: 0, z: 0 };
        out.set(id, { x: o.x + w * q.x, z: o.z + w * q.z });
      }
      total += w;
    }
    for (const [id, o] of out) out.set(id, { x: o.x / total, z: o.z / total });
    return out;
  }

  /** Every player's offset at time t as solved (linear between solved moments; held outside the span). */
  private at(t: number): Map<string, FloorPoint> {
    this.extend(t);
    const ts = this.times;
    if (t <= ts[0]) return new Map(this.solved[0]);
    if (t >= ts[ts.length - 1]) return new Map(this.solved[ts.length - 1]);
    let a = 0, b = ts.length - 1;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (ts[m] <= t) a = m;
      else b = m;
    }
    const u = (t - ts[a]) / (ts[b] - ts[a]);
    const A = this.solved[a], B = this.solved[b];
    const out = new Map<string, FloorPoint>();
    for (const id of new Set([...A.keys(), ...B.keys()])) {
      const p = A.get(id) ?? { x: 0, z: 0 }, q = B.get(id) ?? { x: 0, z: 0 };
      out.set(id, { x: p.x + (q.x - p.x) * u, z: p.z + (q.z - p.z) * u });
    }
    return out;
  }
}

/** The deepest overlap between any two of the bodies, metres (0 when none touch); for tests and checks. */
export function deepestOverlap(players: readonly PosedPlayer[]): number {
  const flat = players.map((p) => packed(playerCapsules(p)));
  let worst = 0;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) worst = Math.max(worst, depthAt(flat[i], flat[j], 0, 0, 0));
  }
  return worst;
}

/** How far any trunk or head reaches through the net plane, metres (0 when none does); for tests and checks. */
export function deepestNetCrossing(players: readonly PosedPlayer[]): number {
  return Math.max(0, ...players.map((p) => -(netClearance(p, playerCapsules(p)) ?? 0)));
}
