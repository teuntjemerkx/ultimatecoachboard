// Port of Store/MatchLog.swift: rally history, per-rotation records and the Match Log rows.
import type { Side } from "./court";
import { JournalPayload, JournalRecord, JournalRecordType, NotePayload } from "./journal";
import type { LiveState } from "./liveStore";
import { type PlayerID, Score } from "./matchState";
import type { SkillCode } from "./skillCoding";

/** One rally with the facts from just before it was played (score, server, rotations). */
export interface RallyRecord {
  /** Sequence number of the RallyWon record. */
  seq: number;
  setNumber: number;
  scoreBefore: Score;
  serving: Side;
  homeRotation: number;
  opponentRotation: number;
  winner: Side;
  server?: PlayerID;
}

export const RallyRecord = {
  id(r: RallyRecord): number {
    return r.seq;
  },

  /** The receiving team won the rally and takes the serve. */
  sideOut(r: RallyRecord): boolean {
    return r.winner !== r.serving;
  },

  scoreAfter(r: RallyRecord): Score {
    const s = { ...r.scoreBefore };
    s[r.winner] += 1;
    return s;
  },

  /** Swift `rotation(of:)`. */
  rotation(r: RallyRecord, side: Side): number {
    return side === "home" ? r.homeRotation : r.opponentRotation;
  },
};

/** A team's record in one rotation: side-out (receiving) and break (serving) rallies. */
export interface RotationRecord {
  rotation: number;
  receiveWon: number;
  receiveLost: number;
  serveWon: number;
  serveLost: number;
}

export const RotationRecord = {
  make(rotation: number): RotationRecord {
    return { rotation, receiveWon: 0, receiveLost: 0, serveWon: 0, serveLost: 0 };
  },

  id(r: RotationRecord): number {
    return r.rotation;
  },

  receiveTotal(r: RotationRecord): number {
    return r.receiveWon + r.receiveLost;
  },

  serveTotal(r: RotationRecord): number {
    return r.serveWon + r.serveLost;
  },

  sideOutRate(r: RotationRecord): number | undefined {
    const total = RotationRecord.receiveTotal(r);
    return total === 0 ? undefined : r.receiveWon / total;
  },
};

export const RotationStats = {
  /** Records for R1 to R6 of one team, over one set or (with `setNumber` undefined) the whole match. */
  records(rallies: readonly RallyRecord[], side: Side, setNumber?: number): RotationRecord[] {
    const out = [1, 2, 3, 4, 5, 6].map(RotationRecord.make);
    for (const r of rallies) {
      if (setNumber !== undefined && r.setNumber !== setNumber) continue;
      const i = RallyRecord.rotation(r, side) - 1;
      if (i < 0 || i >= out.length) continue;
      const won = r.winner === side;
      if (r.serving === side) {
        if (won) out[i].serveWon += 1; else out[i].serveLost += 1;
      } else {
        if (won) out[i].receiveWon += 1; else out[i].receiveLost += 1;
      }
    }
    return out;
  },

  /**
   * The suggested starting rotation for the next set (Appendix C2, Screen 6): the best side-out record; ties go to
   * the rotation with more receptions, then to the lower rotation number. Undefined without receptions.
   */
  suggestedStart(records: readonly RotationRecord[]): RotationRecord | undefined {
    const before = (a: RotationRecord, b: RotationRecord): boolean => {
      const ra = RotationRecord.sideOutRate(a) ?? 0;
      const rb = RotationRecord.sideOutRate(b) ?? 0;
      if (ra !== rb) return ra > rb;
      if (RotationRecord.receiveTotal(a) !== RotationRecord.receiveTotal(b)) {
        return RotationRecord.receiveTotal(a) > RotationRecord.receiveTotal(b);
      }
      return a.rotation < b.rotation;
    };
    let best: RotationRecord | undefined;
    for (const r of records) {
      if (RotationRecord.receiveTotal(r) === 0) continue;
      if (best === undefined || before(r, best)) best = r;
    }
    return best;
  },
};

/** A Match Log row (Appendix C2, Screen 7): a rally and what happened since the previous one. */
export interface MatchLogRow {
  rally: RallyRecord;
  scoutLines: number;
  sketchStrokes: number;
  substitutions: number;
  timeOuts: number;
  notes: string[];
  /** Skill codes of this rally (Advanced Mode). */
  skills: SkillCode[];
}

export const MatchLogRow = {
  make(rally: RallyRecord): MatchLogRow {
    return { rally, scoutLines: 0, sketchStrokes: 0, substitutions: 0, timeOuts: 0, notes: [], skills: [] };
  },

  id(row: MatchLogRow): number {
    return row.rally.seq;
  },
};

export const MatchLog = {
  /**
   * Rows for every active rally, with scouting, sketches, substitutions and time-outs attached to the rally they
   * preceded, and notes attached to the rally they name.
   */
  rows(state: LiveState, records: readonly JournalRecord[]): MatchLogRow[] {
    const rows: MatchLogRow[] = [];
    const bySeq = new Map<number, RallyRecord>();
    for (const r of state.rallies) bySeq.set(r.seq, r);
    let pending = MatchLogRow.make({ seq: 0, setNumber: 0, scoreBefore: Score.make(), serving: "home",
                                     homeRotation: 1, opponentRotation: 1, winner: "home" });
    for (const entry of state.log) {
      if (!entry.active) continue;
      const action = entry.action;
      switch (action.kind) {
        case "rally": {
          const rally = bySeq.get(entry.seq);
          if (rally === undefined) continue;
          rows.push({ ...pending, rally });
          pending = MatchLogRow.make(rally);
          break;
        }
        case "scout": pending.scoutLines += 1; break;
        case "ink": pending.sketchStrokes += 1; break;
        case "substitution": pending.substitutions += 1; break;
        case "timeOut": pending.timeOuts += 1; break;
        case "skill": pending.skills.push(action.code); break;
        case "nextSet":
        case "rotationCorrection": break;
      }
    }
    for (const r of records) {
      switch (JournalRecord.knownType(r)) {
        case JournalRecordType.note: {
          let note: NotePayload;
          try {
            note = JournalPayload.decode(NotePayload, r.payload);
          } catch {
            continue;
          }
          const i = note.afterSeq === undefined ? -1 : rows.findIndex((row) => row.rally.seq === note.afterSeq);
          if (i >= 0) rows[i].notes.push(note.text);
          else if (rows.length > 0) rows[rows.length - 1].notes.push(note.text);
          break;
        }
        default:
          break;
      }
    }
    return rows;
  },
};
