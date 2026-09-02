import type { Clock, Domain } from "@rra/core";
import { getPool, withTransaction, CaseEventStore } from "@rra/db";

export interface OpenCaseRequest {
  caseId: string;
  merchantId: string;
  customerId: string;
  obligationId: string;
  externalRef: string;
  domain: Domain;
  amountPaise: number;
  dueAt: Date;
  holdout: boolean;
}

export interface OpenCaseResult {
  caseId: string;
  /** True when an existing open case for this obligation absorbed the trigger. */
  attached: boolean;
}

/**
 * Opens cases with obligation-level deduplication.
 *
 * The v1 race this closes: `payment_failed` opens a case, then the 20-minute
 * abandonment timer fires and would open a second for the same money. The dedup
 * key is the obligation's (merchant, external_ref) — the order or session, not
 * the customer — so the second trigger attaches to the live case instead.
 */
export class CaseManager {
  private readonly events: CaseEventStore;

  constructor(private readonly clock: Clock) {
    this.events = new CaseEventStore(clock);
  }

  async openOrAttach(req: OpenCaseRequest): Promise<OpenCaseResult> {
    const existing = await withTransaction(async (client) => {
      const { rows: obRows } = await client.query<{ id: string }>(
        `INSERT INTO obligations (id, merchant_id, customer_id, type, amount_paise, due_at, external_ref, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'due')
         ON CONFLICT (merchant_id, external_ref) DO UPDATE SET state = obligations.state
         RETURNING id`,
        [req.obligationId, req.merchantId, req.customerId, req.domain, req.amountPaise, req.dueAt, req.externalRef],
      );
      const obligationId = obRows[0]!.id;

      // An open case against this obligation absorbs the trigger.
      const { rows: caseRows } = await client.query<{ id: string }>(
        `SELECT id FROM cases
          WHERE obligation_id = $1 AND closed_at IS NULL
          ORDER BY opened_at LIMIT 1`,
        [obligationId],
      );
      if (caseRows[0]) return { caseId: caseRows[0].id, attached: true, obligationId };

      await client.query(
        `INSERT INTO cases (id, obligation_id, domain, state, holdout_flag, opened_at)
         VALUES ($1, $2, $3, 'DETECTED', $4, $5)`,
        [req.caseId, obligationId, req.domain, req.holdout, this.clock.now()],
      );
      return { caseId: req.caseId, attached: false, obligationId };
    });

    if (!existing.attached) {
      await this.events.append(
        existing.caseId,
        { type: "case_opened", domain: req.domain, holdout: req.holdout },
        "case_manager",
      );
    }
    return { caseId: existing.caseId, attached: existing.attached };
  }

  async obligationIdFor(caseId: string): Promise<string> {
    const { rows } = await getPool().query<{ obligation_id: string }>(
      "SELECT obligation_id FROM cases WHERE id = $1",
      [caseId],
    );
    const row = rows[0];
    if (!row) throw new Error(`case ${caseId} does not exist`);
    return row.obligation_id;
  }
}
