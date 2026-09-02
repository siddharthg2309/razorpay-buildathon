/**
 * Every component takes a Clock. Nothing calls Date.now() directly and nothing
 * uses SQL now() — the virtual clock is what makes a 14-day dunning sequence
 * run in 90 seconds, and a single stray wall-clock read silently removes a code
 * path from that guarantee.
 */
export interface Clock {
  now(): Date;
}

export class RealClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class VirtualClock implements Clock {
  #current: number;

  constructor(start: Date | number = 0) {
    this.#current = typeof start === "number" ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.#current);
  }

  /** Advance by a duration. Never moves backwards. */
  advance(ms: number): Date {
    if (ms < 0) throw new RangeError(`cannot advance by ${ms}ms; clocks move forward`);
    this.#current += ms;
    return this.now();
  }

  advanceTo(when: Date | number): Date {
    const target = typeof when === "number" ? when : when.getTime();
    if (target < this.#current) {
      throw new RangeError(`cannot rewind clock from ${this.#current} to ${target}`);
    }
    this.#current = target;
    return this.now();
  }
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Readability helpers for scenario and test code. */
export const hours = (n: number): number => n * HOUR_MS;
export const days = (n: number): number => n * DAY_MS;
