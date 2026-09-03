import type { Clock, DeclineTaxonomy, Rail } from "@rra/core";

export type MandateState = "active" | "paused" | "revoked" | "unknown";

export interface MandateFacts {
  rail: Rail;
  state: MandateState;
  /** Cap on a single debit, where the mandate carries one. */
  capPaise: number | null;
  amountPaise: number;
  /** Whether the pre-debit notification for this cycle has gone out. */
  preDebitNotifiedAt: Date | null;
  attemptNo: number;
  /** Bank working days, for rails presented on a cycle rather than on demand. */
  nextPresentationAt: Date | null;
}

export interface SequencedStep {
  actionId: string;
  params: Record<string, unknown>;
  /** Virtual milliseconds from now. */
  delayMs: number;
  because: string;
}

export interface MandateSequence {
  permitted: boolean;
  /** Why a debit is not allowed, when it is not. */
  blockedBy: string | null;
  steps: SequencedStep[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** RBI e-mandate: the notification must precede the debit by at least this. */
export const PRE_DEBIT_NOTICE_MS = 24 * HOUR;

const MANDATE_RAILS = new Set<Rail>(["upi_autopay", "enach"]);

/**
 * Orders the steps around a mandate debit.
 *
 * This is not a retry loop with a delay table. The ordering is regulatory: a
 * pre-debit notification has to reach the customer at least 24 hours before the
 * debit, so a sequencer that retries first and notifies afterwards is compliant
 * on paper and wrong in practice. And a revoked mandate cannot be retried at
 * all — no delay makes it succeed, so every attempt is pure customer harm.
 *
 * The engine already enforces these as policy. Naming the sequence makes it
 * legible: the case trail shows notification before debit, and a reader can
 * check the ordering rather than trust it.
 */
export class MandateRetrySequencer {
  constructor(
    private readonly clock: Clock,
    private readonly taxonomy: DeclineTaxonomy,
  ) {}

  sequence(facts: MandateFacts): MandateSequence {
    if (!MANDATE_RAILS.has(facts.rail)) {
      return { permitted: false, blockedBy: `${facts.rail} carries no mandate`, steps: [] };
    }

    // Revoked is terminal for the instrument. Retrying is the behaviour the
    // stopping rules exist to prevent, not a slower version of success.
    if (facts.state === "revoked") {
      return {
        permitted: false,
        blockedBy: "mandate revoked — no debit can succeed and retrying is customer harm",
        steps: [
          {
            actionId: "request_payment_method_update",
            params: { reason_code: "MANDATE_REVOKED", channel: "whatsapp" },
            delayMs: 0,
            because: "the only path is a new mandate, so ask for one",
          },
        ],
      };
    }

    if (facts.state === "paused") {
      return {
        permitted: false,
        blockedBy: "mandate paused — the payer must resume it before any debit",
        steps: [
          {
            actionId: "request_payment_method_update",
            params: { reason_code: "MANDATE_PAUSED", channel: "whatsapp" },
            delayMs: 0,
            because: "only the payer can lift a pause",
          },
        ],
      };
    }

    const steps: SequencedStep[] = [];

    // A debit above the mandate cap will fail however many times it is tried.
    if (facts.capPaise !== null && facts.amountPaise > facts.capPaise) {
      return {
        permitted: false,
        blockedBy: `attempt ${facts.amountPaise} exceeds mandate cap ${facts.capPaise}`,
        steps: [
          {
            actionId: "request_payment_method_update",
            params: { reason_code: "MANDATE_AMOUNT_EXCEEDED", channel: "whatsapp" },
            delayMs: 0,
            because: "the cap is the binding constraint, not the balance",
          },
        ],
      };
    }

    // The ordering that matters. Notice first, then debit, never the reverse.
    const now = this.clock.now().getTime();
    const notifiedAt = facts.preDebitNotifiedAt?.getTime() ?? null;
    const noticeElapsed = notifiedAt === null ? 0 : now - notifiedAt;

    if (notifiedAt === null) {
      steps.push({
        actionId: "await_mandate_prerequisite",
        params: { prerequisite: "pre_debit_notified" },
        delayMs: 0,
        because: "RBI e-mandate requires notice before the debit; the provider sends it",
      });
      steps.push({
        actionId: "await_provider_retry",
        params: { expected_at_hours: PRE_DEBIT_NOTICE_MS / HOUR },
        delayMs: PRE_DEBIT_NOTICE_MS,
        because: "debit may not be presented until the notice period has run",
      });
    } else if (noticeElapsed < PRE_DEBIT_NOTICE_MS) {
      const remaining = PRE_DEBIT_NOTICE_MS - noticeElapsed;
      steps.push({
        actionId: "await_provider_retry",
        params: { expected_at_hours: Math.ceil(remaining / HOUR) },
        delayMs: remaining,
        because: `notice sent but only ${Math.floor(noticeElapsed / HOUR)}h ago; ${Math.ceil(remaining / HOUR)}h still to run`,
      });
    } else {
      // Notice satisfied. e-NACH presents on bank working days rather than on
      // demand, so the next presentation date governs, not our preferred delay.
      const wait = facts.nextPresentationAt
        ? Math.max(0, facts.nextPresentationAt.getTime() - now)
        : this.#backoffMs(facts.attemptNo);
      steps.push({
        actionId: "await_provider_retry",
        params: { expected_at_hours: Math.ceil(wait / HOUR) },
        delayMs: wait,
        because: facts.nextPresentationAt
          ? "e-NACH presents on bank working days, so the cycle sets the date"
          : `attempt ${facts.attemptNo + 1}: reason-aware backoff`,
      });
    }

    return { permitted: true, blockedBy: null, steps };
  }

  /**
   * Backoff by attempt, not a fixed delay.
   *
   * The first retry is soon because a transient failure clears quickly; later
   * ones are far apart because a balance problem clears on payday, not in an
   * hour. Same shape as the taxonomy's per-code ceilings.
   */
  #backoffMs(attemptNo: number): number {
    const ladder = [6 * HOUR, 2 * DAY, 5 * DAY];
    return ladder[Math.min(attemptNo, ladder.length - 1)]!;
  }

  /** Whether the taxonomy considers another attempt permissible at all. */
  retryPermitted(rail: Rail, code: string, attemptNo: number): boolean {
    return this.taxonomy.classify(rail, code, attemptNo)?.retryPermitted ?? false;
  }
}
