import { mulberry32 } from "@rra/attribution";
import type { Injection } from "./scenario.js";
import type { SyntheticCase } from "./cohort.js";

export interface WorldEvent {
  atMs: number;
  kind: "natural_payment" | "opt_out" | "dispute";
  caseId: string;
}

export interface DegradationWindow {
  fromMs: number;
  toMs: number;
  segment: Record<string, string>;
  approvalDrop: number;
}

/**
 * What the payment world does on its own, independent of the agent.
 *
 * Keeping this separate from the scheduler matters: the scheduler holds what
 * the *agent* decided to do, and this holds what would have happened anyway.
 * Mixing them would make the natural-recovery baseline indistinguishable from
 * agent activity, and the holdout arm exists precisely to measure it.
 */
export class World {
  readonly #events: WorldEvent[];
  readonly #degradations: DegradationWindow[];
  #cursor = 0;
  #rand: () => number;

  constructor(cases: readonly SyntheticCase[], injections: readonly Injection[], seed: number) {
    this.#rand = mulberry32(seed ^ 0x5eed);

    const events: WorldEvent[] = [];
    for (const c of cases) {
      // Natural payment fires for treated and holdout alike. That symmetry is
      // the whole basis of the holdout comparison.
      if (c.latent.naturalPaymentAtMs !== null) {
        events.push({ atMs: c.latent.naturalPaymentAtMs, kind: "natural_payment", caseId: c.caseId });
      }
      if (c.latent.willOptOut) {
        events.push({ atMs: Math.floor(this.#rand() * 3 * 86_400_000), kind: "opt_out", caseId: c.caseId });
      }
      if (c.latent.willDispute) {
        events.push({ atMs: Math.floor(this.#rand() * 5 * 86_400_000), kind: "dispute", caseId: c.caseId });
      }
    }
    events.sort((a, b) => a.atMs - b.atMs || a.caseId.localeCompare(b.caseId));
    this.#events = events;

    this.#degradations = injections.map((i) => ({
      fromMs: i.atHours * 3_600_000,
      toMs: i.atHours * 3_600_000 + i.durationMinutes * 60_000,
      segment: i.segment,
      approvalDrop: i.approvalDrop,
    }));
  }

  /** Events due at or before `elapsedMs` that have not been drained yet. */
  drainUntil(elapsedMs: number): WorldEvent[] {
    const due: WorldEvent[] = [];
    while (this.#cursor < this.#events.length && this.#events[this.#cursor]!.atMs <= elapsedMs) {
      due.push(this.#events[this.#cursor]!);
      this.#cursor++;
    }
    return due;
  }

  /** Is this case's segment inside an injected degradation right now? */
  degradedAt(elapsedMs: number, c: SyntheticCase): DegradationWindow | null {
    return (
      this.#degradations.find(
        (d) =>
          elapsedMs >= d.fromMs &&
          elapsedMs < d.toMs &&
          (d.segment["gateway"] === undefined || d.segment["gateway"] === c.gateway) &&
          (d.segment["issuer"] === undefined || d.segment["issuer"] === c.issuer) &&
          (d.segment["method"] === undefined || d.segment["method"] === railMethod(c.rail)),
      ) ?? null
    );
  }

  get totalEvents(): number {
    return this.#events.length;
  }
}

const railMethod = (rail: string): string =>
  rail === "card" ? "card" : rail.startsWith("upi") ? "upi" : rail;
