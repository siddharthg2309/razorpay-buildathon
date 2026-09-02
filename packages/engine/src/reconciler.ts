import type { Clock } from "@rra/core";
import { getPool } from "@rra/db";

export interface InboundSettlement {
  id: string;
  merchantId: string;
  amountPaise: number;
  source: string;
  reference?: string;
  /** Present when the money came back through an action we initiated. */
  idemKey?: string;
  /** Present for Smart Collect: the customer paid into a virtual account. */
  virtualAccount?: string;
}

export type MatchStrategy = "idem_key" | "virtual_account" | "reference" | "unmatched";

export interface MatchResult {
  settlementId: string;
  obligationId: string | null;
  matchedBy: MatchStrategy;
}

/**
 * Matches money received to the obligation it settles.
 *
 * Order matters: an idempotency key is an exact link back to an action we
 * initiated, so it wins. A virtual account is the B2B path — the customer
 * transfers without any action of ours, which is reconciliation rather than
 * recovery. Reference matching is last and weakest.
 *
 * An unmatched settlement stays unmatched. Guessing here would credit the agent
 * with money it did not cause, which is the one number the whole demo rests on.
 */
export class Reconciler {
  constructor(private readonly clock: Clock) {}

  async record(s: InboundSettlement): Promise<MatchResult> {
    const match = await this.#match(s);
    await getPool().query(
      `INSERT INTO settlements
         (id, merchant_id, obligation_id, amount_paise, reference, idem_key, virtual_account, source, matched_by, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        s.id, s.merchantId, match.obligationId, s.amountPaise, s.reference ?? null,
        s.idemKey ?? null, s.virtualAccount ?? null, s.source, match.matchedBy, this.clock.now(),
      ],
    );
    return match;
  }

  async #match(s: InboundSettlement): Promise<MatchResult> {
    if (s.idemKey) {
      const { rows } = await getPool().query<{ obligation_id: string }>(
        "SELECT obligation_id FROM action_attempts WHERE idem_key = $1",
        [s.idemKey],
      );
      if (rows[0]) {
        return { settlementId: s.id, obligationId: rows[0].obligation_id, matchedBy: "idem_key" };
      }
    }

    if (s.virtualAccount) {
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM obligations
          WHERE virtual_account = $1 AND merchant_id = $2 AND state <> 'settled'
          ORDER BY due_at LIMIT 1`,
        [s.virtualAccount, s.merchantId],
      );
      if (rows[0]) {
        return { settlementId: s.id, obligationId: rows[0].id, matchedBy: "virtual_account" };
      }
    }

    if (s.reference) {
      const { rows } = await getPool().query<{ id: string }>(
        "SELECT id FROM obligations WHERE external_ref = $1 AND merchant_id = $2",
        [s.reference, s.merchantId],
      );
      if (rows[0]) {
        return { settlementId: s.id, obligationId: rows[0].id, matchedBy: "reference" };
      }
    }

    return { settlementId: s.id, obligationId: null, matchedBy: "unmatched" };
  }

  /** Total settled against an obligation — an obligation may be paid in parts. */
  async settledAmount(obligationId: string): Promise<number> {
    const { rows } = await getPool().query<{ total: string | null }>(
      "SELECT sum(amount_paise) AS total FROM settlements WHERE obligation_id = $1",
      [obligationId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async unmatched(): Promise<{ id: string; amountPaise: number; source: string }[]> {
    const { rows } = await getPool().query<{ id: string; amount_paise: string; source: string }>(
      "SELECT id, amount_paise, source FROM settlements WHERE obligation_id IS NULL ORDER BY received_at",
    );
    return rows.map((r) => ({ id: r.id, amountPaise: Number(r.amount_paise), source: r.source }));
  }
}
