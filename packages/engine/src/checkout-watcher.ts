import type { Clock } from "@rra/core";
import { Ledger, getPool } from "@rra/db";

export interface CheckoutEvent {
  sessionId: string;
  merchantId: string;
  customerId: string;
  externalRef: string;
  amountPaise: number;
  stage: string;
}

export interface AbandonedSession {
  sessionId: string;
  merchantId: string;
  customerId: string;
  externalRef: string;
  amountPaise: number;
  lastStage: string;
  idleMs: number;
}

/**
 * Converts a quiet checkout session into an abandonment case.
 *
 * Abandonment is near-real-time, not instant: a customer who paused for two
 * minutes has not left. The watcher waits for a configured inactivity threshold
 * before deciding, which is the difference between recovering abandoned
 * checkouts and interrupting live ones.
 *
 * The signal is first-party. A checkout that was never attempted produces no
 * PSP event, so inventing one would blur the simulated/live boundary — this
 * reads our own funnel telemetry instead.
 */
export class CheckoutWatcher {
  private readonly ledger: Ledger;

  constructor(
    private readonly clock: Clock,
    /** Inactivity before a session counts as abandoned. */
    private readonly thresholdMs = 20 * 60_000,
  ) {
    this.ledger = new Ledger(clock);
  }

  /** Record activity. Re-activity on a live session pushes the clock forward. */
  async touch(e: CheckoutEvent): Promise<void> {
    await getPool().query(
      `INSERT INTO checkout_sessions
         (id, merchant_id, customer_id, external_ref, amount_paise, last_stage, last_active_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (merchant_id, external_ref) DO UPDATE
         SET last_stage = $6, last_active_at = $7`,
      [e.sessionId, e.merchantId, e.customerId, e.externalRef, e.amountPaise, e.stage, this.clock.now()],
    );
  }

  /** The customer completed. Nothing to recover. */
  async complete(merchantId: string, externalRef: string): Promise<void> {
    await getPool().query(
      "UPDATE checkout_sessions SET completed_at = $3 WHERE merchant_id = $1 AND external_ref = $2",
      [merchantId, externalRef, this.clock.now()],
    );
  }

  /**
   * Sessions idle past the threshold, not completed, and not already converted.
   * A session whose payment failed is deliberately left alone: the payment
   * failure opens its own case on the same obligation, and sending generic cart
   * messaging alongside payment recovery is the conflict the brief calls out.
   */
  async abandoned(): Promise<AbandonedSession[]> {
    const cutoff = new Date(this.clock.now().getTime() - this.thresholdMs);
    const { rows } = await getPool().query<{
      id: string; merchant_id: string; customer_id: string; external_ref: string;
      amount_paise: string; last_stage: string; last_active_at: Date;
    }>(
      `SELECT s.id, s.merchant_id, s.customer_id, s.external_ref, s.amount_paise,
              s.last_stage, s.last_active_at
         FROM checkout_sessions s
        WHERE s.completed_at IS NULL
          AND s.case_id IS NULL
          AND s.last_active_at <= $1
          AND NOT EXISTS (
            SELECT 1 FROM obligations o
             WHERE o.merchant_id = s.merchant_id AND o.external_ref = s.external_ref
          )
        ORDER BY s.last_active_at`,
      [cutoff],
    );
    return rows.map((r) => ({
      sessionId: r.id,
      merchantId: r.merchant_id,
      customerId: r.customer_id,
      externalRef: r.external_ref,
      amountPaise: Number(r.amount_paise),
      lastStage: r.last_stage,
      idleMs: this.clock.now().getTime() - r.last_active_at.getTime(),
    }));
  }

  /** Link the session to the case it produced, so it is never converted twice. */
  async markConverted(sessionId: string, caseId: string): Promise<void> {
    await getPool().query("UPDATE checkout_sessions SET case_id = $2 WHERE id = $1", [sessionId, caseId]);
    await this.ledger.append({
      caseId, actor: "checkout_watcher", eventType: "abandonment_detected",
      payload: { sessionId, thresholdMinutes: this.thresholdMs / 60_000 },
    });
  }
}
