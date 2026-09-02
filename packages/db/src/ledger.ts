import type { PoolClient } from "pg";
import type { Clock, LedgerEntry } from "@rra/core";
import { getPool } from "./pool.js";

export interface LedgerAppend {
  caseId: string;
  actor: string;
  eventType: string;
  payload?: Record<string, unknown>;
  policyVersion?: string;
}

/**
 * Append-only. There is no update or delete path by design — the ledger is the
 * replay source and the audit-trail claim rests on it being immutable.
 */
export class Ledger {
  constructor(private readonly clock: Clock) {}

  async append(entry: LedgerAppend, client?: PoolClient): Promise<void> {
    const q = client ?? getPool();
    await q.query(
      `INSERT INTO ledger (case_id, ts, actor, event_type, payload, policy_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.caseId,
        this.clock.now(),
        entry.actor,
        entry.eventType,
        JSON.stringify(entry.payload ?? {}),
        entry.policyVersion ?? null,
      ],
    );
  }

  async read(caseId: string): Promise<LedgerEntry[]> {
    const { rows } = await getPool().query<{
      case_id: string;
      ts: Date;
      actor: string;
      event_type: string;
      payload: Record<string, unknown>;
      policy_version: string | null;
    }>(`SELECT case_id, ts, actor, event_type, payload, policy_version
        FROM ledger WHERE case_id = $1 ORDER BY id`, [caseId]);

    return rows.map((r) => ({
      caseId: r.case_id,
      ts: r.ts,
      actor: r.actor,
      eventType: r.event_type,
      payload: r.payload,
      ...(r.policy_version !== null ? { policyVersion: r.policy_version } : {}),
    }));
  }
}
