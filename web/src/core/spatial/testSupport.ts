// Test helpers shared by the spatial/ and zones/ test files (ports of the Swift test target's helpers).
import { expect } from "vitest";

/** Deterministic random numbers for property tests (SplitMix64), bit-identical to the Swift test helper. */
export class SplitMix64 {
  private state: bigint;
  constructor(seed: number | bigint) {
    this.state = BigInt(seed) & 0xffffffffffffffffn;
  }
  next(): bigint {
    const mask = 0xffffffffffffffffn;
    this.state = (this.state + 0x9e3779b97f4a7c15n) & mask;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return z ^ (z >> 31n);
  }
  /** `next() % m` as a number. */
  nextMod(m: number): number {
    return Number(this.next() % BigInt(m));
  }
}

/** XCTAssertEqual(a, b, accuracy:). */
export function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  const ok = Math.abs(actual - expected) <= accuracy;
  if (!ok) expect.fail(`${message ? message + ": " : ""}${actual} is not within ${accuracy} of ${expected}`);
}

/** Swift `stride(from:through:by:)` on Double. */
export function strideThrough(from: number, through: number, by: number): number[] {
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const v = from + i * by;
    if (v > through) break;
    out.push(v);
  }
  return out;
}
