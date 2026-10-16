// Port of Store/LiveStore.swift: the single source of truth for the Live screens, a reducer over LiveEvents
// with exact undo and journal replay. (CoachMode and InkStroke live in liveTypes.ts.)
import {
  type Codec, type JsonValue, JsonReader, DecodingError, compact, decodeTagged, decodeUUID, encodeTagged,
} from "./codable";
import { CourtPosition, LocalPoint, Side } from "./court";
import {
  JournalPayload, JournalRecord, JournalRecordType, MatchStartedPayload, ModeChangedPayload, RallyWonPayload,
  RotationCorrectionPayload, SeqPayload, SketchStrokesPayload, SubstitutionPayload, TimeOutPayload,
} from "./journal";
import { type CoachMode, InkStroke } from "./liveTypes";
import type { RallyRecord } from "./matchLog";
import { MatchError, MatchState, type PlayerID, TeamSheet } from "./matchState";
import { MicroScout, ScoutLine } from "./microScout";
import { ConstraintResult, OverlapEngine } from "./overlapEngine";
import { RotationTemplate, TemplateLibrary } from "./rotationTemplate";
import type { RuleCourtProfile } from "./ruleCourtProfile";
import { type Skill, SkillCode, type SkillGrade } from "./skillCoding";

/** Swift `LiveContext`: `.live`, `.panicTimeOut(startedAt:)`, `.setBreak`, `.matchOver`. */
export type LiveContext =
  | { kind: "live" }
  | { kind: "panicTimeOut"; startedAt: number }
  | { kind: "setBreak" }
  | { kind: "matchOver" };

const live: LiveContext = Object.freeze({ kind: "live" });
const setBreak: LiveContext = Object.freeze({ kind: "setBreak" });
const matchOver: LiveContext = Object.freeze({ kind: "matchOver" });

export const LiveContext = {
  live,
  setBreak,
  matchOver,

  panicTimeOut(startedAt: number): LiveContext {
    return { kind: "panicTimeOut", startedAt };
  },

  encode(c: LiveContext): JsonValue {
    return c.kind === "panicTimeOut" ? encodeTagged("panicTimeOut", { startedAt: c.startedAt }) : encodeTagged(c.kind);
  },

  decode(json: unknown, what = "LiveContext"): LiveContext {
    const [tag, p] = decodeTagged(json, what);
    switch (tag) {
      case "live": return live;
      case "panicTimeOut": return { kind: "panicTimeOut", startedAt: p.num("startedAt") };
      case "setBreak": return setBreak;
      case "matchOver": return matchOver;
      default: throw new DecodingError(`${what}: unknown case ${tag}`);
    }
  },
};

export type HapticPattern =
  | "originAccepted" | "landingAccepted" | "rejected" | "point" | "sideOut" | "overlapWarning" | "overlapFault"
  | "panic" | "undo";

/**
 * - `haptic`: play a pattern.
 * - `journal`: append a record; the record's sequence number equals `LiveState.nextSeq` before the event.
 * - `commitJournal`: commit the journal group now (rally ends, time-outs, match end).
 */
export type LiveEffect =
  | { kind: "haptic"; pattern: HapticPattern }
  | { kind: "journal"; type: JournalRecordType; payload: Uint8Array }
  | { kind: "commitJournal" };

export const LiveEffect = {
  haptic(pattern: HapticPattern): LiveEffect {
    return { kind: "haptic", pattern };
  },
  journal(type: JournalRecordType, payload: Uint8Array): LiveEffect {
    return { kind: "journal", type, payload };
  },
  commitJournal: Object.freeze({ kind: "commitJournal" }) as LiveEffect,
};

/** Swift `LiveEvent`; the `LiveEvent` functions build each case. */
export type LiveEvent =
  | { kind: "pointSwipe"; winner: Side }
  | { kind: "scoutTap"; side: Side; point: LocalPoint; time: number }
  | { kind: "tick"; time: number }
  | { kind: "panicPressed"; time: number }
  | { kind: "panicDone" }
  | { kind: "ink"; stroke: InkStroke }
  | { kind: "moveToken"; side: Side; position: CourtPosition; to: LocalPoint }
  | { kind: "resetTokens" }
  | { kind: "substitution"; side: Side; outgoing: PlayerID; incoming: PlayerID }
  | { kind: "toggleMode" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "startNextSet"; firstServer?: Side; homeStartRotation?: number }
  | { kind: "correctRotation"; side: Side; setterPosition?: CourtPosition; serving?: Side }
  /** Advanced Mode: one coded touch from the skill pad (Screen 4). */
  | { kind: "skill"; side: Side; player: PlayerID; skill: Skill; grade: SkillGrade };

export const LiveEvent = {
  pointSwipe: (winner: Side): LiveEvent => ({ kind: "pointSwipe", winner }),
  scoutTap: (side: Side, point: LocalPoint, time: number): LiveEvent => ({ kind: "scoutTap", side, point, time }),
  tick: (time: number): LiveEvent => ({ kind: "tick", time }),
  panicPressed: (time: number): LiveEvent => ({ kind: "panicPressed", time }),
  panicDone: { kind: "panicDone" } as LiveEvent,
  ink: (stroke: InkStroke): LiveEvent => ({ kind: "ink", stroke }),
  moveToken: (side: Side, position: CourtPosition, to: LocalPoint): LiveEvent => ({ kind: "moveToken", side, position, to }),
  resetTokens: { kind: "resetTokens" } as LiveEvent,
  substitution: (side: Side, outgoing: PlayerID, incoming: PlayerID): LiveEvent =>
    ({ kind: "substitution", side, outgoing, incoming }),
  toggleMode: { kind: "toggleMode" } as LiveEvent,
  undo: { kind: "undo" } as LiveEvent,
  redo: { kind: "redo" } as LiveEvent,
  startNextSet: (firstServer?: Side, homeStartRotation?: number): LiveEvent =>
    ({ kind: "startNextSet", firstServer, homeStartRotation }),
  correctRotation: (side: Side, setterPosition?: CourtPosition, serving?: Side): LiveEvent =>
    ({ kind: "correctRotation", side, setterPosition, serving }),
  skill: (side: Side, player: PlayerID, skill: Skill, grade: SkillGrade): LiveEvent =>
    ({ kind: "skill", side, player, skill, grade }),
};

/** A token as drawn on the board. */
export interface BoardToken {
  side: Side;
  position: CourtPosition;
  player: PlayerID;
  role: string;
  point: LocalPoint;
  isServer: boolean;
  isLibero: boolean;
}

/** Undoable actions, kept in order; derived state is rebuilt from the active ones (exact undo). */
export type LiveAction =
  | { kind: "rally"; winner: Side }
  | { kind: "substitution"; side: Side; outgoing: PlayerID; incoming: PlayerID }
  | { kind: "scout"; line: ScoutLine }
  | { kind: "ink"; stroke: InkStroke }
  | { kind: "nextSet"; firstServer?: Side; homeStartRotation?: number }
  | { kind: "rotationCorrection"; side: Side; setterPosition?: CourtPosition; serving?: Side }
  | { kind: "skill"; code: SkillCode };

/** Swift's JSON shape for an enum with unlabelled associated values: {"rally": {"_0": "home"}}. */
export const LiveAction = {
  encode(a: LiveAction): JsonValue {
    switch (a.kind) {
      case "rally": return encodeTagged("rally", { _0: a.winner });
      case "substitution": return encodeTagged("substitution", { _0: a.side, _1: a.outgoing, _2: a.incoming });
      case "scout": return encodeTagged("scout", { _0: ScoutLine.encode(a.line) });
      case "ink": return encodeTagged("ink", { _0: InkStroke.encode(a.stroke) });
      case "nextSet": return encodeTagged("nextSet", { _0: a.firstServer, _1: a.homeStartRotation });
      case "rotationCorrection": return encodeTagged("rotationCorrection", { _0: a.side, _1: a.setterPosition, _2: a.serving });
      case "skill": return encodeTagged("skill", { _0: SkillCode.encode(a.code) });
    }
  },

  decode(json: unknown, what = "LiveAction"): LiveAction {
    const [tag, p] = decodeTagged(json, what);
    switch (tag) {
      case "rally": return { kind: "rally", winner: p.req("_0", Side.decode) };
      case "substitution":
        return { kind: "substitution", side: p.req("_0", Side.decode), outgoing: p.req("_1", decodeUUID),
                 incoming: p.req("_2", decodeUUID) };
      case "scout": return { kind: "scout", line: p.req("_0", ScoutLine.decode) };
      case "ink": return { kind: "ink", stroke: p.req("_0", InkStroke.decode) };
      case "nextSet": return { kind: "nextSet", firstServer: p.opt("_0", Side.decode), homeStartRotation: p.optInt("_1") };
      case "rotationCorrection":
        return { kind: "rotationCorrection", side: p.req("_0", Side.decode), setterPosition: p.opt("_1", CourtPosition.decode),
                 serving: p.opt("_2", Side.decode) };
      case "skill": return { kind: "skill", code: p.req("_0", SkillCode.decode) };
      default: throw new DecodingError(`${what}: unknown case ${tag}`);
    }
  },
};

export interface LoggedAction {
  seq: number;
  action: LiveAction;
  active: boolean;
}

export const LoggedAction = {
  encode(a: LoggedAction): JsonValue {
    return { seq: a.seq, action: LiveAction.encode(a.action), active: a.active };
  },

  decode(json: unknown, what = "LoggedAction"): LoggedAction {
    const r = new JsonReader(json, what);
    return { seq: r.int("seq"), action: r.req("action", LiveAction.decode), active: r.bool("active") };
  },
};

export interface SetStartedPayload {
  firstServer?: Side;
  /** The home team's starting rotation for the new set; undefined keeps the match's starting lineup. */
  homeStartRotation?: number;
}

export const SetStartedPayload: Codec<SetStartedPayload> = {
  encode: (p) => compact({ firstServer: p.firstServer, homeStartRotation: p.homeStartRotation }),
  decode: (json) => {
    const r = new JsonReader(json, "SetStartedPayload");
    return { firstServer: r.opt("firstServer", Side.decode), homeStartRotation: r.optInt("homeStartRotation") };
  },
};

export interface MatchEndedPayload {
  setsHome: number;
  setsOpponent: number;
}

export const MatchEndedPayload: Codec<MatchEndedPayload> = {
  encode: (p) => ({ setsHome: p.setsHome, setsOpponent: p.setsOpponent }),
  decode: (json) => {
    const r = new JsonReader(json, "MatchEndedPayload");
    return { setsHome: r.int("setsHome"), setsOpponent: r.int("setsOpponent") };
  },
};

/** Swift's `try?`: a MatchError is swallowed, anything else is a bug and propagates. */
function attempt(f: () => void): boolean {
  try {
    f();
    return true;
  } catch (e) {
    if (e instanceof MatchError) return false;
    throw e;
  }
}

/**
 * The single source of truth for the Live screens; a pure reducer (blueprint Section 2.2).
 * A Swift value type: `reduce` changes this instance; `clone()` copies it (e.g. to keep the previous state for React).
 */
export class LiveState {
  readonly setup: MatchStartedPayload;
  readonly profile: RuleCourtProfile;
  /** The home team's template; the opponent's is `opponentTemplate`. */
  readonly template: RotationTemplate;
  readonly opponentTemplate: RotationTemplate;
  private _mode: CoachMode;
  private _context: LiveContext;
  private _match: MatchState;
  private _scout: MicroScout;
  private _scoutLines: ScoutLine[];
  private _ink: InkStroke[];
  private _log: LoggedAction[];
  private _redoStack: number[];
  private _overrides: Map<Side, Map<CourtPosition, LocalPoint>>;
  private _nextSeq: number;
  private _rallies: RallyRecord[];
  private _skillCodes: SkillCode[];

  constructor({ setup, profile, template, opponentTemplate, nextSeq = 2 }: {
    setup: MatchStartedPayload; profile: RuleCourtProfile; template: RotationTemplate;
    opponentTemplate?: RotationTemplate; nextSeq?: number;
  }) {
    this.setup = setup;
    this.profile = profile;
    this.template = template;
    this.opponentTemplate = opponentTemplate ?? template;
    this._mode = setup.mode;
    this._context = live;
    this._match = new MatchState({ profile, home: setup.home, opponent: setup.opponent, firstServer: setup.firstServer });
    this._scout = new MicroScout();
    this._scoutLines = [];
    this._ink = [];
    this._log = [];
    this._redoStack = [];
    this._overrides = new Map();
    this._nextSeq = nextSeq;
    this._rallies = [];
    this._skillCodes = [];
  }

  get mode(): CoachMode { return this._mode; }
  get context(): LiveContext { return this._context; }
  /** Treat as read-only. */
  get match(): MatchState { return this._match; }
  get scout(): MicroScout { return this._scout; }
  get scoutLines(): readonly ScoutLine[] { return this._scoutLines; }
  get ink(): readonly InkStroke[] { return this._ink; }
  get log(): readonly LoggedAction[] { return this._log; }
  get redoStack(): readonly number[] { return this._redoStack; }
  get overrides(): ReadonlyMap<Side, ReadonlyMap<CourtPosition, LocalPoint>> { return this._overrides; }
  get nextSeq(): number { return this._nextSeq; }
  /** Every rally of the active log, in order, with the facts from just before it was played. */
  get rallies(): readonly RallyRecord[] { return this._rallies; }
  /** Advanced Mode skill codes of the active log, in order. */
  get skillCodes(): readonly SkillCode[] { return this._skillCodes; }

  /** A copy that shares nothing mutable with this state (Swift value semantics). */
  clone(): LiveState {
    const s = Object.create(LiveState.prototype) as LiveState;
    Object.assign(s, {
      setup: this.setup, profile: this.profile, template: this.template, opponentTemplate: this.opponentTemplate,
      _mode: this._mode, _context: this._context, _match: this._match.clone(), _scout: this._scout.clone(),
      _scoutLines: [...this._scoutLines], _ink: [...this._ink], _log: this._log.map((e) => ({ ...e })),
      _redoStack: [...this._redoStack],
      _overrides: new Map([...this._overrides].map(([side, m]) => [side, new Map(m)])),
      _nextSeq: this._nextSeq, _rallies: [...this._rallies], _skillCodes: [...this._skillCodes],
    });
    return s;
  }

  // MARK: - Reducer

  reduce(event: LiveEvent): LiveEffect[] {
    switch (event.kind) {
      case "pointSwipe": {
        if (this._context.kind !== "live" || this._match.isOver || this._match.current.winner !== undefined) {
          return [LiveEffect.haptic("rejected")];
        }
        const probe = this._match.clone();
        let outcome;
        try {
          outcome = probe.applyRally(event.winner);
        } catch (e) {
          if (e instanceof MatchError) return [LiveEffect.haptic("rejected")];
          throw e;
        }
        const effects = this.record({ kind: "rally", winner: event.winner }, JournalRecordType.rallyWon, RallyWonPayload,
                                    { winner: event.winner });
        this.rebuild();
        this._overrides = new Map();
        if (outcome.matchEnded) {
          effects.push(...this.record(undefined, JournalRecordType.matchEnded, MatchEndedPayload,
                                      { setsHome: this._match.setsWonHome, setsOpponent: this._match.setsWonOpponent }));
        }
        effects.push(LiveEffect.haptic(outcome.sideOut ? "sideOut" : "point"));
        effects.push(LiveEffect.commitJournal);
        return effects;
      }

      case "scoutTap": {
        if (this._context.kind !== "live") return [];
        const ctx = this.scoutContext();
        const result = this._scout.tap(event.side, event.point, event.time, ctx);
        if (result.kind === "originAccepted" || result.kind === "originReplaced") return [LiveEffect.haptic("originAccepted")];
        if (result.kind === "committed") {
          const effects = this.record({ kind: "scout", line: result.line }, JournalRecordType.scoutLine, ScoutLine,
                                      result.line);
          this.rebuild();
          effects.push(LiveEffect.haptic("landingAccepted"));
          return effects;
        }
        return [LiveEffect.haptic("rejected")];   // rejected or expired
      }

      case "tick":
        return this._scout.tick(event.time) ? [LiveEffect.haptic("rejected")] : [];

      case "panicPressed":
        if (this._context.kind !== "live") return [];
        this._context = LiveContext.panicTimeOut(event.time);
        this._scout.cancel();
        return [...this.record(undefined, JournalRecordType.timeOutStarted, TimeOutPayload, { side: "home" }),
                LiveEffect.haptic("panic"), LiveEffect.commitJournal];

      case "panicDone":
        if (this._context.kind !== "panicTimeOut") return [];
        this._context = this._match.isOver ? matchOver : (this._match.current.winner !== undefined ? setBreak : live);
        return [...this.record(undefined, JournalRecordType.timeOutEnded, TimeOutPayload, { side: "home" }),
                LiveEffect.commitJournal];

      case "ink": {
        const effects = this.record({ kind: "ink", stroke: event.stroke }, JournalRecordType.sketchStrokes,
                                    SketchStrokesPayload, { strokes: [event.stroke] });
        this.rebuild();
        return effects;
      }

      case "moveToken": {
        let bySide = this._overrides.get(event.side);
        if (bySide === undefined) this._overrides.set(event.side, bySide = new Map());
        bySide.set(event.position, event.to);
        const results = this.currentConstraints(event.side);
        if (results.some((r) => !ConstraintResult.isLegal(r))) return [LiveEffect.haptic("overlapFault")];
        if (results.some((r) => r.margin < 0.25)) return [LiveEffect.haptic("overlapWarning")];
        return [];
      }

      case "resetTokens":
        this._overrides = new Map();
        return [];

      case "substitution": {
        const probe = this._match.clone();
        if (!attempt(() => probe.substitute(event.side, event.outgoing, event.incoming))) {
          return [LiveEffect.haptic("rejected")];
        }
        const effects = this.record({ kind: "substitution", side: event.side, outgoing: event.outgoing, incoming: event.incoming },
                                    JournalRecordType.substitution, SubstitutionPayload,
                                    { side: event.side, outgoing: event.outgoing, incoming: event.incoming });
        this.rebuild();
        return [...effects, LiveEffect.commitJournal];
      }

      case "toggleMode":
        this._mode = this._mode === "solo" ? "advanced" : "solo";
        return this.record(undefined, JournalRecordType.modeChanged, ModeChangedPayload, { mode: this._mode });

      case "undo": {
        let index = -1;
        for (let i = this._log.length - 1; i >= 0; i--) if (this._log[i].active) { index = i; break; }
        if (index < 0) return [LiveEffect.haptic("rejected")];
        const seq = this._log[index].seq;
        this._log[index] = { ...this._log[index], active: false };
        this._redoStack.push(seq);
        const effects = this.record(undefined, JournalRecordType.undo, SeqPayload, { seq });
        this.rebuild();
        return [...effects, LiveEffect.haptic("undo"), LiveEffect.commitJournal];
      }

      case "redo": {
        const seq = this._redoStack.pop();
        const index = seq === undefined ? -1 : this._log.findIndex((e) => e.seq === seq);
        if (seq === undefined || index < 0) return [LiveEffect.haptic("rejected")];
        this._log[index] = { ...this._log[index], active: true };
        const effects = this.record(undefined, JournalRecordType.redo, SeqPayload, { seq });
        this.rebuild();
        return [...effects, LiveEffect.commitJournal];
      }

      case "startNextSet": {
        if (this._match.current.winner === undefined || this._match.isOver) return [LiveEffect.haptic("rejected")];
        const { firstServer, homeStartRotation } = event;
        const effects = this.record({ kind: "nextSet", firstServer, homeStartRotation }, JournalRecordType.setStarted,
                                    SetStartedPayload, { firstServer, homeStartRotation });
        this.rebuild();
        return [...effects, LiveEffect.commitJournal];
      }

      case "skill": {
        if (this._context.kind !== "live" || this._match.current.winner !== undefined) return [LiveEffect.haptic("rejected")];
        const code: SkillCode = {
          side: event.side, player: event.player, skill: event.skill, grade: event.grade,
          setNumber: this._match.current.number, score: { ...this._match.current.score },
          homeRotation: this._match.rotationNumber("home"), opponentRotation: this._match.rotationNumber("opponent"),
        };
        const effects = this.record({ kind: "skill", code }, JournalRecordType.skillCode, SkillCode, code);
        this.rebuild();
        return [...effects, LiveEffect.haptic("originAccepted")];
      }

      case "correctRotation": {
        const { side, setterPosition, serving } = event;
        const effects = this.record({ kind: "rotationCorrection", side, setterPosition, serving },
                                    JournalRecordType.rotationCorrection, RotationCorrectionPayload,
                                    { side, rotations: undefined, setterPosition, serving });
        this.rebuild();
        return [...effects, LiveEffect.commitJournal];
      }
    }
    return [];
  }

  // MARK: - Journal bookkeeping

  private record<P>(action: LiveAction | undefined, type: JournalRecordType, codec: Codec<P>, payload: P): LiveEffect[] {
    let data: Uint8Array;
    try {
      data = JournalPayload.encode(codec, payload);
    } catch {
      data = new Uint8Array();
    }
    const seq = this._nextSeq;
    this._nextSeq += 1;
    if (action !== undefined) {
      this._log.push({ seq, action, active: true });
      this._redoStack = [];
    }
    return [LiveEffect.journal(type, data)];
  }

  /** Re-derives match, scouting and ink from the active actions (exact undo and replay). */
  private rebuild(): void {
    const m = new MatchState({ profile: this.profile, home: this.setup.home, opponent: this.setup.opponent,
                               firstServer: this.setup.firstServer });
    const lines: ScoutLine[] = [];
    const strokes: InkStroke[] = [];
    const played: RallyRecord[] = [];
    const codes: SkillCode[] = [];
    for (const entry of this._log) {
      if (!entry.active) continue;
      const a = entry.action;
      switch (a.kind) {
        case "rally": {
          const before: RallyRecord = {
            seq: entry.seq, setNumber: m.current.number, scoreBefore: { ...m.current.score }, serving: m.current.serving,
            homeRotation: m.rotationNumber("home"), opponentRotation: m.rotationNumber("opponent"), winner: a.winner,
            server: m.onCourt(m.current.serving).get(1),
          };
          if (attempt(() => m.applyRally(a.winner))) played.push(before);
          break;
        }
        case "substitution":
          attempt(() => m.substitute(a.side, a.outgoing, a.incoming));
          break;
        case "scout":
          lines.push(a.line);
          break;
        case "ink":
          strokes.push(a.stroke);
          break;
        case "nextSet": {
          const start = a.homeStartRotation;
          attempt(() => m.startNextSet({ homeLineup: start === undefined ? undefined : m.lineupStartingIn("home", start),
                                         firstServer: a.firstServer }));
          break;
        }
        case "rotationCorrection":
          m.correctRotation(a.side, { setterPosition: a.setterPosition, rotations: undefined, serving: a.serving });
          break;
        case "skill":
          codes.push(a.code);
          break;
      }
    }
    this._match = m;
    this._scoutLines = lines;
    this._ink = strokes;
    this._rallies = played;
    this._skillCodes = codes;
    if (this._context.kind === "panicTimeOut") return;
    this._context = m.isOver ? matchOver : (m.current.winner !== undefined ? setBreak : live);
  }

  // MARK: - Derived board

  /** The template phase for a side: the serving team stands in its serve formation. */
  phase(side: Side): string {
    return this._match.current.serving === side ? "serve" : "receive";
  }

  /** Swift `template(for:)`. */
  templateFor(side: Side): RotationTemplate {
    return side === "home" ? this.template : this.opponentTemplate;
  }

  /** Tokens for both teams: template anchors by position, overridden by any drag in this rally. */
  tokens(): BoardToken[] {
    const out: BoardToken[] = [];
    const match = this._match;
    for (const side of Side.allCases) {
      const onCourt = match.onCourt(side);
      const sheet = match.sheets[side];
      const formation = RotationTemplate.formationFor(this.templateFor(side), match, side, this.phase(side));
      const anchors = formation !== undefined ? RotationTemplate.positions(formation)
        : LiveState.genericAnchors(match.current.serving === side);
      for (const pos of CourtPosition.allCases) {
        const id = onCourt.get(pos);
        if (id === undefined) continue;
        const isLibero = sheet?.liberos.includes(id) ?? false;
        const role = isLibero ? "L" : (match.displayRole(id, side) ?? CourtPosition.label(pos));
        const point = this._overrides.get(side)?.get(pos) ?? anchors.get(pos) ?? LiveState.genericAnchors(false).get(pos)!;
        out.push({ side, position: pos, player: id, role, point,
                   isServer: pos === 1 && match.current.serving === side, isLibero });
      }
    }
    return out;
  }

  /** Legality of a side's current pre-service positions. */
  currentConstraints(side: Side): ConstraintResult[] {
    const positions = new Map<CourtPosition, LocalPoint>();
    for (const t of this.tokens()) if (t.side === side) positions.set(t.position, t.point);
    const serving = this._match.current.serving === side;
    const checked = serving ? this.profile.overlap.checkServingTeam : this.profile.overlap.checkReceivingTeam;
    if (!checked) return [];
    return OverlapEngine.evaluate(positions, { serving, serverExempt: this.profile.overlap.serverExempt,
                                               options: OverlapEngine.optionsFor(this.profile) });
  }

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

  scoutContext(): MicroScout.Context {
    const front = new Map<CourtPosition, string>();
    const back = new Map<CourtPosition, string>();
    const sheet = this._match.sheets.opponent;
    for (const [pos, id] of this._match.onCourt("opponent")) {
      const role = (sheet ? TeamSheet.role(sheet, id) : undefined) ?? "";
      if (CourtPosition.isFrontRow(pos)) front.set(pos, role);
      else back.set(pos, role);
    }
    return MicroScout.context({ setNumber: this._match.current.number, score: { ...this._match.current.score },
                                homeRotation: this._match.rotationNumber("home"),
                                opponentRotation: this._match.rotationNumber("opponent"),
                                opponentFrontRowRoles: front, opponentBackRowRoles: back });
  }

  // MARK: - Replay

  /** Skill codes since the last rally (the touches of the rally being played). */
  get codesThisRally(): SkillCode[] {
    let out: SkillCode[] = [];
    for (const entry of this._log) {
      if (!entry.active) continue;
      switch (entry.action.kind) {
        case "rally":
        case "nextSet":
          out = [];
          break;
        case "skill":
          out.push(entry.action.code);
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** The home team's substitutes right now (roster bench plus starters who went off). */
  get homeBench(): PlayerID[] {
    return this._match.bench("home", this.setup.homeBench ?? []);
  }

  /** A what-if copy for the RING tool: the home team in any rotation and phase of its template. Swift `previewing(homeRotation:phase:)`. */
  previewing(homeRotation: number, phase: string): LiveState {
    const s = this.clone();
    s._match.correctRotation("home", { setterPosition: CourtPosition.fromRawValue(homeRotation),
                                       rotations: (7 - homeRotation) % 6, serving: phase === "serve" ? "home" : "opponent" });
    s._overrides = new Map();
    s._context = live;
    return s;
  }

  /**
   * The state as it was just before the action with sequence number `seq` (Match Log, read-only board): everything
   * logged from `seq` on is set aside, so later undos are respected exactly. Swift `rewound(before:)`.
   */
  rewound(seq: number): LiveState {
    const s = this.clone();
    s._log = s._log.map((e) => (e.seq >= seq ? { ...e, active: false } : e));
    s._redoStack = [];
    s._overrides = new Map();
    s._context = live;
    s.rebuild();
    return s;
  }

  /**
   * Rebuilds a Live state from journal records (crash recovery, Match Log replay). Without `templates` both teams'
   * templates come from the MatchStarted record; with them, `opponentTemplate` defaults to `template` (Swift's two
   * `replay` overloads). Returns undefined when the first record is not MatchStarted; throws when it cannot be decoded.
   */
  static replay(records: readonly JournalRecord[], profile: RuleCourtProfile,
                templates?: { template: RotationTemplate; opponentTemplate?: RotationTemplate }): LiveState | undefined {
    const first = records[0];
    if (first === undefined || JournalRecord.knownType(first) !== JournalRecordType.matchStarted) return undefined;
    const setup = JournalPayload.decode(MatchStartedPayload, first.payload);
    const template = templates?.template ?? TemplateLibrary.template(setup.templateID);
    const opponentTemplate = templates ? templates.opponentTemplate
      : TemplateLibrary.template(setup.opponentTemplateID ?? MatchStartedPayload.defaultOpponentTemplateID);
    const state = new LiveState({ setup, profile, template, opponentTemplate, nextSeq: first.seq + 1 });
    for (const r of records.slice(1)) {
      state._nextSeq = r.seq;
      // A record whose payload cannot be decoded is skipped, never fatal: recovery must not lose a match.
      const decode = <T>(codec: Codec<T>): T | undefined => {
        try {
          return JournalPayload.decode(codec, r.payload);
        } catch {
          return undefined;
        }
      };
      switch (JournalRecord.knownType(r)) {
        case JournalRecordType.rallyWon: {
          const p = decode(RallyWonPayload);
          if (p) state.appendReplayed({ kind: "rally", winner: p.winner }, r.seq);
          break;
        }
        case JournalRecordType.scoutLine: {
          const line = decode(ScoutLine);
          if (line) state.appendReplayed({ kind: "scout", line }, r.seq);
          break;
        }
        case JournalRecordType.sketchStrokes: {
          const p = decode(SketchStrokesPayload);
          if (p) for (const stroke of p.strokes) state.appendReplayed({ kind: "ink", stroke }, r.seq);
          break;
        }
        case JournalRecordType.substitution: {
          const p = decode(SubstitutionPayload);
          if (p) state.appendReplayed({ kind: "substitution", side: p.side, outgoing: p.outgoing, incoming: p.incoming }, r.seq);
          break;
        }
        case JournalRecordType.setStarted: {
          const p = decode(SetStartedPayload);
          if (p) state.appendReplayed({ kind: "nextSet", firstServer: p.firstServer, homeStartRotation: p.homeStartRotation }, r.seq);
          break;
        }
        case JournalRecordType.rotationCorrection: {
          const p = decode(RotationCorrectionPayload);
          if (p) {
            const setterPosition = p.setterPosition === undefined ? undefined : CourtPosition.fromRawValue(p.setterPosition);
            state.appendReplayed({ kind: "rotationCorrection", side: p.side, setterPosition, serving: p.serving }, r.seq);
          }
          break;
        }
        case JournalRecordType.undo: {
          const p = decode(SeqPayload);
          const i = p === undefined ? -1 : state._log.findIndex((e) => e.seq === p.seq);
          if (p && i >= 0) {
            state._log[i] = { ...state._log[i], active: false };
            state._redoStack.push(p.seq);
          }
          break;
        }
        case JournalRecordType.redo: {
          const p = decode(SeqPayload);
          const i = p === undefined ? -1 : state._log.findIndex((e) => e.seq === p.seq);
          if (p && i >= 0) {
            state._log[i] = { ...state._log[i], active: true };
            state._redoStack = state._redoStack.filter((s) => s !== p.seq);
          }
          break;
        }
        case JournalRecordType.modeChanged: {
          const p = decode(ModeChangedPayload);
          if (p) state._mode = p.mode;
          break;
        }
        case JournalRecordType.skillCode: {
          const code = decode(SkillCode);
          if (code) state.appendReplayed({ kind: "skill", code }, r.seq);
          break;
        }
        default:
          break;   // types without derived state (notes, time-outs, view facts) or unknown types
      }
      state._nextSeq = r.seq + 1;
    }
    state.rebuild();
    return state;
  }

  private appendReplayed(action: LiveAction, seq: number): void {
    this._log.push({ seq, action, active: true });
    this._redoStack = [];
  }
}
