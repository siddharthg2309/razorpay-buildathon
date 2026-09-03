import { randomUUID } from "node:crypto";
import type { Clock } from "@rra/core";
import { Ledger, getPool } from "@rra/db";
import type { Verifier } from "./verifier.js";

export type CustomerIntent =
  | "will_pay" | "will_update" | "dispute" | "opt_out" | "missing_po" | "unknown";

export interface IntentContext {
  caseId: string;
  obligationId: string;
  amountPaise: number;
  /** When the customer said they would pay, if they said so. */
  promisedFor?: Date;
}

export type IntentOutcome =
  | { action: "terminal"; state: "DISPUTED" | "OPTED_OUT"; reason: string }
  | { action: "record_promise"; promiseId: string; promisedFor: Date }
  | { action: "request_information"; field: string; templateId: string }
  | { action: "continue"; reason: string };

/**
 * Turns an interpreted customer intent into a decision.
 *
 * The reply interpreter returns an enum and nothing else — it has no tools and
 * cannot emit an action. This is the deterministic code that decides what the
 * enum means, which is what keeps untrusted customer text as data: the worst a
 * crafted message can do is pick a different branch of this switch, and every
 * branch is one a human wrote.
 */
export class IntentRouter {
  private readonly ledger: Ledger;

  constructor(
    private readonly verifier: Verifier,
    private readonly clock: Clock,
    /** How long a promise gets before it counts as broken. */
    private readonly promiseGraceMs = 2 * 86_400_000,
  ) {
    this.ledger = new Ledger(clock);
  }

  async route(intent: CustomerIntent, ctx: IntentContext): Promise<IntentOutcome> {
    switch (intent) {
      case "dispute": {
        // A dispute outranks every recovery plan. Continuing to chase a
        // disputed charge is the behaviour the stopping rules exist to prevent.
        await this.verifier.onOutcome({ caseId: ctx.caseId, result: "disputed" });
        return { action: "terminal", state: "DISPUTED", reason: "customer disputed the obligation" };
      }
      case "opt_out": {
        await this.verifier.onOutcome({ caseId: ctx.caseId, result: "opted_out" });
        return { action: "terminal", state: "OPTED_OUT", reason: "customer opted out of contact" };
      }
      case "will_pay": {
        // A promise is evidence, not money. It is recorded, it suppresses
        // further chasing until its date, and it never moves the case toward
        // RECOVERED — only a matched settlement does that.
        const promisedFor =
          ctx.promisedFor ?? new Date(this.clock.now().getTime() + this.promiseGraceMs);
        const promiseId = randomUUID();
        await getPool().query(
          `INSERT INTO promises_to_pay (id, case_id, obligation_id, promised_at, promised_for, amount_paise, source)
           VALUES ($1,$2,$3,$4,$5,$6,'customer_reply')`,
          [promiseId, ctx.caseId, ctx.obligationId, this.clock.now(), promisedFor, ctx.amountPaise],
        );
        await this.ledger.append({
          caseId: ctx.caseId, actor: "intent_router", eventType: "promise_recorded",
          payload: { promiseId, promisedFor: promisedFor.toISOString(), note: "evidence, not recovered money" },
        });
        return { action: "record_promise", promiseId, promisedFor };
      }
      case "missing_po": {
        await this.ledger.append({
          caseId: ctx.caseId, actor: "intent_router", eventType: "information_requested",
          payload: { field: "purchase_order", template: "EM_PO_REQUEST" },
        });
        return { action: "request_information", field: "purchase_order", templateId: "EM_PO_REQUEST" };
      }
      case "will_update":
        return { action: "continue", reason: "customer intends to update their payment method" };
      case "unknown":
        return { action: "continue", reason: "no actionable intent extracted" };
    }
  }

  /**
   * Settle promises whose date has passed. A kept promise is closed by the
   * settlement that arrived; a broken one releases the case to be chased again.
   */
  async reconcilePromises(): Promise<{ kept: number; broken: number }> {
    const now = this.clock.now();
    const { rows } = await getPool().query<{ id: string; case_id: string; obligation_id: string }>(
      "SELECT id, case_id, obligation_id FROM promises_to_pay WHERE state = 'open' AND promised_for <= $1",
      [now],
    );
    let kept = 0;
    let broken = 0;
    for (const p of rows) {
      const { rowCount } = await getPool().query(
        "SELECT 1 FROM settlements WHERE obligation_id = $1 LIMIT 1",
        [p.obligation_id],
      );
      const wasKept = (rowCount ?? 0) > 0;
      await getPool().query(
        "UPDATE promises_to_pay SET state = $2, settled_at = $3 WHERE id = $1",
        [p.id, wasKept ? "kept" : "broken", now],
      );
      await this.ledger.append({
        caseId: p.case_id, actor: "intent_router",
        eventType: wasKept ? "promise_kept" : "promise_broken",
        payload: { promiseId: p.id },
      });
      if (wasKept) kept++;
      else broken++;
    }
    return { kept, broken };
  }

  async openPromises(caseId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM promises_to_pay WHERE case_id = $1 AND state = 'open'",
      [caseId],
    );
    return Number(rows[0]!.n);
  }
}
