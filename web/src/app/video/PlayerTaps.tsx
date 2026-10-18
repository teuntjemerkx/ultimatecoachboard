import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CourtFrame, type Side } from "../../core/match/court";
import { V3 } from "../../core/spatial";
import {
  boxOverlap, type ImagePoint, type PersonDetection, type PictureBox, type TrackLock, type VideoCamera, type VideoScene,
} from "../../core/video";
import { Icon } from "../ui/Icon";
import { grabFrame, SEEK_INTO_FRAME, type Clip } from "./clip";
import { peopleOnStill } from "./pipeline";

/** One tap on a player: when, their feet, and the box tapped (none when the tap was on the court itself). */
export interface TapKey {
  time: number;
  foot: ImagePoint;
  box?: PictureBox;
}

/** A player the coach tapped, at one moment or more (each later tap puts them right there). */
export interface TappedPlayer {
  id: number;
  side: Side;
  keys: TapKey[];
}

/** The taps as the build takes them. */
export function locksOf(players: readonly TappedPlayer[]): TrackLock[] {
  return players.flatMap((p) => p.keys.map((k) => (k.box ? { time: k.time, foot: k.foot, box: k.box, player: p.id }
    : { time: k.time, foot: k.foot, player: p.id })));
}

/** Taps kept with a rebuilt video, as players again. */
export function playersOf(locks: readonly TrackLock[], camera: VideoCamera): TappedPlayer[] {
  const out: TappedPlayer[] = [];
  locks.forEach((l, i) => {
    const id = l.player ?? 1000 + i;
    let p = out.find((q) => q.id === id);
    if (!p) {
      const floor = camera.floorPoint(l.foot);
      p = { id, side: floor ? CourtFrame.side(floor) : "home", keys: [] };
      out.push(p);
    }
    p.keys.push(l.box ? { time: l.time, foot: l.foot, box: l.box } : { time: l.time, foot: l.foot });
  });
  return out;
}

/** The id the build gives a tapped player's track (`PlayerTracker.followInPicture`). */
export const trackIdOf = (player: number) => `tap-${player}`;

type Found = { detection: PersonDetection; box: PictureBox }[];

/**
 * Standing inside the court's lines (15 cm of slack for the feet): a player, picked from the start. A coach at the
 * sideline stands just outside and is left for the coach to tap, if anyone.
 */
const insideLines = (p: { x: number; z: number }) => Math.abs(p.x) <= CourtFrame.halfWidth + 0.15 && Math.abs(p.z) <= 9.15;

/**
 * The people picked from the start: those inside the lines, best detection first. Left out: a box much shorter than
 * a person standing there (legs or a torso the detector boxed apart), and a second box the detector put on someone
 * already picked (mostly inside theirs, standing on about the same spot); a player farther back, seen behind
 * someone, stays.
 */
export function preselect(people: Found, camera: VideoCamera): number[] {
  const picked: number[] = [];
  const inside = (a: PictureBox, b: PictureBox) => {
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (w * h) / Math.min(a.w * a.h, b.w * b.h);
  };
  /** How tall someone of 1.75 m stands at a floor point in the picture, pixels. */
  const tall = (p: { x: number; z: number }) => {
    const feet = camera.project(V3.fromFloor(p, 0)), head = camera.project(V3.fromFloor(p, 1.75));
    return feet && head ? feet.y - head.y : 0;
  };
  people.forEach((p, i) => {
    const f = p.detection.floor;
    if (!insideLines(f) || p.box.h < 0.55 * tall(f)) return;
    const twin = picked.some((j) => {
      const g = people[j].detection.floor;
      return inside(people[j].box, p.box) > 0.6 && Math.hypot(f.x - g.x, f.z - g.z) < 1.2;
    });
    if (!twin) picked.push(i);
  });
  return picked;
}

/** The label a tapped player goes by: ours 1, 2, 3 ... and theirs A, B, C ... in the order they were tapped. */
function labelsOf(players: readonly TappedPlayer[], scene?: VideoScene): Map<number, string> {
  const out = new Map<number, string>();
  let ours = 0, theirs = 0;
  for (const p of players) {
    const rebuilt = scene?.players.find((q) => q.id === trackIdOf(p.id));
    out.set(p.id, rebuilt?.label ?? (p.side === "home" ? String(++ours) : String.fromCharCode(65 + theirs++)));
  }
  return out;
}

/** Keys taken at the moment shown (the slider moves in tenths of a second). */
const sameMoment = (a: number, b: number) => Math.abs(a - b) < 0.05;

/**
 * Tapping the players to follow, at any moment of the rally: a slider picks the moment, the still shows a box around
 * everyone the detector finds there, and a tap on a box picks that person. With a player chosen below, the tap puts
 * that player right at this moment (the build holds them there whatever the tracking said); a tap on a picked box at
 * its own moment takes the tap back; a tap on the court where there is no box places the player standing there (the
 * tap is their feet). After a build (`scene`), a ring shows where the 3D had each player at the moment shown.
 */
export function PlayerTaps({ clip, start, length, camera, players, onPlayers, scene, initialTime, onBack, backLabel, onBuild }: {
  clip: Clip;
  start: number;
  /** How long the rally is, seconds from `start`. */
  length: number;
  camera: VideoCamera;
  /** The players tapped so far; undefined picks those inside the lines on the first still. */
  players: TappedPlayer[] | undefined;
  onPlayers: (players: TappedPlayer[]) => void;
  scene?: VideoScene;
  initialTime?: number;
  onBack: () => void;
  backLabel: string;
  onBuild: () => void;
}) {
  const [time, setTime] = useState(() => Math.round((initialTime ?? 0.2) * 10) / 10);
  const [found, setFound] = useState<{ time: number; people: Found; finding: boolean; failed: boolean }>(
    { time: -1, people: [], finding: true, failed: false });
  const [active, setActive] = useState<number | undefined>();
  const [version, setVersion] = useState(0);
  const stillRef = useRef<HTMLCanvasElement | null>(null);
  const cache = useRef(new Map<number, Found>());
  const request = useRef(0);
  const list = players ?? [];
  const labels = labelsOf(list, scene);

  // The still and its people at the moment chosen (after the slider rests briefly; each moment is detected once).
  useEffect(() => {
    const ask = ++request.current;
    const timer = setTimeout(async () => {
      setFound((f) => ({ ...f, finding: true, failed: false }));
      try {
        const canvas = await grabFrame(clip, start + time + SEEK_INTO_FRAME, stillRef.current ?? undefined);
        if (ask !== request.current) return;
        stillRef.current = canvas;
        setVersion((v) => v + 1);
        const key = Math.round(time * 10);
        let people = cache.current.get(key);
        if (!people) {
          people = await peopleOnStill(canvas, camera);
          cache.current.set(key, people);
        }
        if (ask !== request.current) return;
        setFound({ time, people, finding: false, failed: false });
        if (players === undefined) {
          onPlayers(preselect(people, camera).map((i, n) => ({
            id: n + 1, side: CourtFrame.side(people![i].detection.floor),
            keys: [{ time, foot: people![i].detection.footImage, box: people![i].box }],
          })));
        }
      } catch {
        if (ask === request.current) setFound({ time, people: [], finding: false, failed: true });
      }
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, clip, start, camera]);

  const people = found.time === time ? found.people : [];
  /** The player a box at this moment was tapped for. */
  const ownerOf = (box: PictureBox) => list.find((p) => p.keys.some((k) => k.box && sameMoment(k.time, time) && boxOverlap(k.box, box) > 0.5));
  const nextId = () => list.reduce((m, p) => Math.max(m, p.id), 0) + 1;

  const tapBox = (box: PictureBox, foot: ImagePoint, floor: { x: number; z: number }) => {
    const owner = ownerOf(box);
    if (owner) {
      // Take the tap back (the player goes when it was their only one).
      const keys = owner.keys.filter((k) => !(k.box && sameMoment(k.time, time) && boxOverlap(k.box, box) > 0.5));
      onPlayers(keys.length > 0 ? list.map((p) => (p === owner ? { ...p, keys } : p)) : list.filter((p) => p !== owner));
      return;
    }
    addKey({ time, foot, box }, floor);
  };

  const addKey = (key: TapKey, floor: { x: number; z: number }) => {
    const target = list.find((p) => p.id === active);
    if (target) {
      // The chosen player is here at this moment (instead of any earlier tap of theirs at this moment).
      const keys = [...target.keys.filter((k) => !sameMoment(k.time, time)), key].sort((a, b) => a.time - b.time);
      onPlayers(list.map((p) => (p === target ? { ...p, keys } : p)));
    } else {
      onPlayers([...list, { id: nextId(), side: CourtFrame.side(floor), keys: [key] }]);
    }
  };

  const tapCourt = (p: ImagePoint) => {
    // A hand-placed player at this moment: tapped again, gone.
    const placed = list.find((q) => q.keys.some((k) => !k.box && sameMoment(k.time, time) && Math.hypot(k.foot.x - p.x, k.foot.y - p.y) < 30));
    if (placed) {
      const keys = placed.keys.filter((k) => !(!k.box && sameMoment(k.time, time) && Math.hypot(k.foot.x - p.x, k.foot.y - p.y) < 30));
      onPlayers(keys.length > 0 ? list.map((q) => (q === placed ? { ...q, keys } : q)) : list.filter((q) => q !== placed));
      return;
    }
    const floor = camera.floorPoint(p);
    if (floor && Math.abs(floor.x) <= CourtFrame.halfWidth + 2 && Math.abs(floor.z) <= 11) addKey({ time, foot: p }, floor);
  };

  const allOnCourt = () => {
    const here = preselect(people, camera).filter((i) => !ownerOf(people[i].box));
    let id = nextId();
    onPlayers([...list, ...here.map((i) => ({ id: id++, side: CourtFrame.side(people[i].detection.floor),
      keys: [{ time, foot: people[i].detection.footImage, box: people[i].box }] }))]);
  };

  const ours = list.filter((p) => p.side === "home").length;
  const chosen = list.find((p) => p.id === active);
  const step = (d: number) => setTime((t) => Math.min(Math.max(0, Math.round((t + d) * 10) / 10), Math.floor(length * 10) / 10));

  return (
    <div className="video-mark">
      <div className="video-mark-head">
        <strong>Tap the players to follow</strong>
        <span className="muted">
          {chosen
            ? `Taps now put ${labels.get(chosen.id)} right at this moment. Slide to where the 3D lost them and tap where they really are.`
            : "Only the players you tap are rebuilt. Slide to any moment and tap a player there: one who comes in later too. Tap a picked box again to take it back."}
        </span>
      </div>
      <TapStill still={stillRef.current} version={version} size={{ w: clip.width, h: clip.height }} camera={camera} time={time}
                people={people} players={list} labels={labels} scene={scene} finding={found.finding} failed={found.failed}
                ownerOf={ownerOf} onBox={tapBox} onCourt={tapCourt} />
      <div className="video-taps">
        <div className="video-time">
          <button className="btn quiet" aria-label="A tenth of a second back" onClick={() => step(-0.1)}><Icon name="chevronLeft" /></button>
          <input type="range" min={0} max={Math.floor(length * 10) / 10} step={0.1} value={time} aria-label="Moment"
                 onChange={(e) => setTime(Number(e.target.value))} />
          <button className="btn quiet" aria-label="A tenth of a second on" onClick={() => step(0.1)}><Icon name="chevronRight" /></button>
          <span className="video-time-at">{time.toFixed(1)} s</span>
        </div>
        <div className="video-chips" role="group" aria-label="Who a tap is for">
          <button className={`video-chip new${active === undefined ? " on" : ""}`} aria-pressed={active === undefined}
                  onClick={() => setActive(undefined)}><Icon name="plus" /> New</button>
          {list.map((p) => (
            <button key={p.id} className={`video-chip ${p.side}${active === p.id ? " on" : ""}`} aria-pressed={active === p.id}
                    onClick={() => setActive(active === p.id ? undefined : p.id)}
                    aria-label={`Player ${labels.get(p.id)}, ${p.keys.length} tap${p.keys.length === 1 ? "" : "s"}`}>
              {labels.get(p.id)}{p.keys.length > 1 && <span className="video-chip-n">{p.keys.length}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="video-mark-foot">
        <span className="video-badge good"><Icon name="target" />
          {list.length === 0 ? "No one picked: the players are found automatically" : `Following ${list.length}: ${ours} ours, ${list.length - ours} theirs`}
        </span>
        <span className="spacer" />
        <button className="btn quiet" onClick={onBack}><Icon name="chevronLeft" /> {backLabel}</button>
        <button className="btn quiet" disabled={found.finding || people.length === 0} onClick={allOnCourt}>All on court</button>
        <button className="btn quiet" disabled={list.length === 0} onClick={() => { onPlayers([]); setActive(undefined); }}>None</button>
        <button className="btn primary" disabled={found.finding && players === undefined} onClick={onBuild}><Icon name="cube" /> Build 3D</button>
      </div>
    </div>
  );
}

/**
 * The still at the moment shown: a box around everyone the detector found (picked ones in their team's colour with
 * their label, the others dashed), hand-placed players at this moment, and after a build a ring where the 3D had each
 * player. A tap on a box (a few points of slack; of several, the one whose middle is nearest) goes to `onBox`, a tap
 * elsewhere to `onCourt`.
 */
function TapStill({ still, version, size, camera, time, people, players, labels, scene, finding, failed, ownerOf, onBox, onCourt }: {
  still: HTMLCanvasElement | null;
  version: number;
  size: { w: number; h: number };
  camera: VideoCamera;
  time: number;
  people: Found;
  players: readonly TappedPlayer[];
  labels: Map<number, string>;
  scene?: VideoScene;
  finding: boolean;
  failed: boolean;
  ownerOf: (box: PictureBox) => TappedPlayer | undefined;
  onBox: (box: PictureBox, foot: ImagePoint, floor: { x: number; z: number }) => void;
  onCourt: (p: ImagePoint) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !still) return;
    c.width = still.width;
    c.height = still.height;
    c.getContext("2d")!.drawImage(still, 0, 0);
  }, [still, version]);

  const s = Math.min(box.w / size.w, box.h / size.h) || 0;
  const fit = { w: size.w * s, h: size.h * s, x: (box.w - size.w * s) / 2, y: (box.h - size.h * s) / 2 };
  /** At least this wide on screen, so a far player is a target a finger can hit. */
  const wide = (b: PictureBox) => {
    const w = Math.max(b.w, 22 / Math.max(s, 1e-3));
    return { ...b, x: b.x + (b.w - w) / 2, w };
  };
  /** A hand-placed player: feet at the tap, as tall as someone of 1.85 m stands there in the picture. */
  const placed = (foot: ImagePoint) => {
    const floor = camera.floorPoint(foot);
    const head = floor ? camera.project(V3.fromFloor(floor, 1.85)) : undefined;
    const h = head ? Math.max(8, foot.y - head.y) : 40;
    return wide({ x: foot.x - 0.2 * h, y: foot.y - h, w: 0.4 * h, h });
  };
  const shown = people.map((p) => wide(p.box));
  const hand = players.flatMap((p) => p.keys.filter((k) => !k.box && sameMoment(k.time, time)).map((k) => ({ player: p, b: placed(k.foot) })));
  // Where the last build had each tapped player at this moment.
  const rings = scene ? scene.markers(time).flatMap((m) => {
    const p = players.find((q) => `tap-${q.id}` === m.id);
    return p ? [{ player: p, foot: { x: m.foot.x * size.w, y: m.foot.y * size.h }, head: { x: m.head.x * size.w, y: m.head.y * size.h } }] : [];
  }) : [];

  const tap = (e: ReactPointerEvent) => {
    if (finding || !(s > 0)) return;
    const r = boxRef.current!.getBoundingClientRect();
    const p = { x: (e.clientX - r.left - fit.x) / s, y: (e.clientY - r.top - fit.y) / s };
    if (p.x < 0 || p.y < 0 || p.x > size.w || p.y > size.h) return;
    const slack = 10 / s;
    const hit = (b: PictureBox) =>
      p.x >= b.x - slack && p.x <= b.x + b.w + slack && p.y >= b.y - slack && p.y <= b.y + b.h + slack
        ? Math.abs(p.x - (b.x + b.w / 2)) / b.w + Math.abs(p.y - (b.y + b.h / 2)) / b.h : Infinity;
    const onHand = hand.find((h) => hit(h.b) < Infinity);
    if (onHand) { onCourt({ x: onHand.b.x + onHand.b.w / 2, y: onHand.b.y + onHand.b.h }); return; }
    let best = -1, d = Infinity;
    shown.forEach((b, i) => { const q = hit(b); if (q < d) { d = q; best = i; } });
    if (best >= 0) onBox(people[best].box, people[best].detection.footImage, people[best].detection.floor);
    else onCourt(p);
  };

  const pct = (q: ImagePoint) => ({ left: `${(q.x / size.w) * 100}%`, top: `${(q.y / size.h) * 100}%` });

  return (
    <div className="video-still-box" ref={boxRef} onPointerUp={tap}>
      <div className="video-still" style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}>
        <canvas ref={canvasRef} />
        <svg viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" aria-hidden="true" className="video-people">
          {rings.map((r) => (
            <ellipse key={`r${r.player.id}`} cx={r.foot.x} cy={r.foot.y} rx={Math.max(10 / Math.max(s, 1e-3), 0.25 * (r.foot.y - r.head.y))}
                     ry={Math.max(4 / Math.max(s, 1e-3), 0.08 * (r.foot.y - r.head.y))} className={`ring ${r.player.side}`} vectorEffect="non-scaling-stroke" />
          ))}
          {shown.map((b, i) => {
            const owner = ownerOf(people[i].box);
            return (
              <rect key={`p${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(b.w / 2, 8 / Math.max(s, 1e-3))}
                    className={owner ? `picked ${owner.side}` : "free"} vectorEffect="non-scaling-stroke" />
            );
          })}
          {hand.map((h, i) => (
            <rect key={`h${i}`} x={h.b.x} y={h.b.y} width={h.b.w} height={h.b.h} rx={Math.min(h.b.w / 2, 8 / Math.max(s, 1e-3))}
                  className={`picked tapped ${h.player.side}`} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {shown.map((b, i) => {
          const owner = ownerOf(people[i].box);
          return owner ? <span key={`l${i}`} className={`video-tag ${owner.side}`} style={pct({ x: b.x + b.w / 2, y: b.y })}>{labels.get(owner.id)}</span> : null;
        })}
        {hand.map((h, i) => <span key={`hl${i}`} className={`video-tag ${h.player.side}`} style={pct({ x: h.b.x + h.b.w / 2, y: h.b.y })}>{labels.get(h.player.id)}</span>)}
        {rings.map((r) => <span key={`rl${r.player.id}`} className={`video-tag ring ${r.player.side}`} style={pct(r.foot)}>{labels.get(r.player.id)}</span>)}
      </div>
      {finding && <div className="video-finding">Finding the players…</div>}
      {failed && <div className="video-finding">No one found here. Tap the players' feet, or slide on.</div>}
    </div>
  );
}
