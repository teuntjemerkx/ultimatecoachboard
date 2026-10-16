// Test helpers shared by the match tests (ports of the helpers in the Swift test files). Not part of the public API.
import { expect } from "vitest";
import { CourtPosition } from "./court";
import { JournalPayload, type JournalRecord, JournalRecordType, MatchStartedPayload } from "./journal";
import type { LiveEffect, LiveEvent, LiveState } from "./liveStore";
import { MatchError, type MatchErrorCode, newPlayerID, type PlayerID, TeamSheet } from "./matchState";
import { TemplateLibrary } from "./rotationTemplate";
import { LineupBuilder, TeamSystem } from "./teamSystem";

const MASK64 = (1n << 64n) - 1n;

/**
 * Deterministic random numbers for property tests (SplitMix64), with Swift's standard-library algorithms for
 * `Double.random(in: closedRange, using:)` and `Bool.random(using:)` on top. 64-bit maths needs BigInt (tests only).
 */
export class SplitMix64 {
  private state: bigint;

  constructor(seed: number | bigint) {
    this.state = BigInt(seed) & MASK64;
  }

  next(): bigint {
    this.state = (this.state + 0x9E3779B97F4A7C15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
    return z ^ (z >> 31n);
  }

  /** Swift `next(upperBound:)`: Lemire's nearly divisionless method. */
  nextBelow(upperBound: bigint): bigint {
    let m = this.next() * upperBound;
    if ((m & MASK64) < upperBound) {
      const t = ((0n - upperBound) & MASK64) % upperBound;
      while ((m & MASK64) < t) m = this.next() * upperBound;
    }
    return m >> 64n;
  }

  /** Swift `Double.random(in: lo...hi, using:)`. */
  double(lo: number, hi: number): number {
    const delta = hi - lo;
    const maxSignificand = 1n << 53n;
    const rand = this.nextBelow(maxSignificand + 1n);
    if (rand === maxSignificand) return hi;
    return delta * (Number(rand) * (Number.EPSILON / 2)) + lo;
  }

  /** Swift `Bool.random(using:)`. */
  bool(): boolean {
    return ((this.next() >> 17n) & 1n) === 0n;
  }
}

/** XCTAssertEqual(_:_:accuracy:). */
export function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} vs ${expected} (accuracy ${accuracy})`).toBeLessThanOrEqual(accuracy);
}

export function expectMatchError(f: () => unknown, code: MatchErrorCode): void {
  let thrown: unknown;
  try {
    f();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(MatchError);
  expect((thrown as MatchError).code).toBe(code);
}

/** A 5-1 team in lineup order S, OH1, MB1, OPP, OH2, MB2 starting in R1 (setter in P1), with a libero. */
export class TestTeam {
  readonly s = newPlayerID();
  readonly oh1 = newPlayerID();
  readonly mb1 = newPlayerID();
  readonly opp = newPlayerID();
  readonly oh2 = newPlayerID();
  readonly mb2 = newPlayerID();
  readonly libero = newPlayerID();
  readonly bench = newPlayerID();

  get sheet(): TeamSheet {
    return TeamSheet.make({
      startingLineup: [this.s, this.oh1, this.mb1, this.opp, this.oh2, this.mb2],
      roles: { [this.s]: "S", [this.oh1]: "OH1", [this.mb1]: "MB1", [this.opp]: "OPP", [this.oh2]: "OH2",
               [this.mb2]: "MB2", [this.libero]: "L", [this.bench]: "OH" },
      liberos: [this.libero],
      liberoPartners: [this.mb1, this.mb2],
    });
  }
}

/** Six players placed on P1...P6 plus a libero, as Match Setup builds them. */
export class PlacedTeam {
  readonly ids = new Map<CourtPosition, PlayerID>(CourtPosition.allCases.map((p) => [p, newPlayerID()]));
  readonly libero = newPlayerID();

  sheet(system: TeamSystem, anchor: CourtPosition = 1, withLibero = true): TeamSheet {
    const t = TemplateLibrary.template(TeamSystem.templateID(system));
    return LineupBuilder.sheet({ players: this.ids, order: t.lineupOrder, anchor,
                                 libero: withLibero ? this.libero : undefined, liberoReplaces: t.libero?.replaces ?? [] });
  }
}

/** The MatchStarted record the Swift tests start every journal with. */
export function matchStartedRecord(state: LiveState): JournalRecord {
  return { type: JournalRecordType.matchStarted, origin: 0, seq: 1, lamport: 1, wallClock: 0,
           payload: JournalPayload.encode(MatchStartedPayload, state.setup) };
}

/** The Swift tests' `run`: reduces an event and journals every record it emits, numbered from `nextSeq`. */
export function run(state: LiveState, records: JournalRecord[], event: LiveEvent): LiveEffect[] {
  let seq = state.nextSeq;
  const effects = state.reduce(event);
  for (const effect of effects) {
    if (effect.kind === "journal") {
      records.push({ type: effect.type, origin: 0, seq, lamport: seq, wallClock: 0, payload: effect.payload });
      seq += 1;
    }
  }
  return effects;
}
