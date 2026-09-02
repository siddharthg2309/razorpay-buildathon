import type { PoolClient } from "pg";
import {
  isTerminal,
  reduceAll,
  type CaseEvent,
  type CaseId,
  type CaseRevision,
  type Clock,
  type StoredCaseEvent,
} from "@rra/core";
import { getPool, withTransaction } from "./pool.js";

/**
 * Appends an event and persists the resulting revision in one transaction.
 *
 * seq is allocated under `SELECT ... FOR UPDATE` on the case row. Without that
 * lock, two events arriving for the same case race on UNIQUE(case_id, seq) and
 * one of them fails on a constraint rather than queueing behind the other.
 */
export class CaseEventStore {
  constructor(private readonly clock: Clock) {}

  async append(
    caseId: CaseId,
    event: CaseEvent,
    source: string,
  ): Promise<{ stored: StoredCaseEvent; revision: CaseRevision }> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{ next_seq: string }>(
        "SELECT next_seq FROM cases WHERE id = $1 FOR UPDATE",
        [caseId],
      );
      const row = rows[0];
      if (!row) throw new Error(`case ${caseId} does not exist`);
      const seq = Number(row.next_seq);
      const occurredAt = this.clock.now();

      await client.query(
        `INSERT INTO case_events (case_id, seq, type, payload, source, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [caseId, seq, event.type, JSON.stringify(event), source, occurredAt],
      );
      await client.query("UPDATE cases SET next_seq = next_seq + 1 WHERE id = $1", [caseId]);

      const stored: StoredCaseEvent = { caseId, seq, event, source, occurredAt };
      const revision = reduceAll(caseId, await this.#readAll(caseId, client));

      await client.query(
        `INSERT INTO case_revisions (case_id, revision, state_json, reduced_through_seq, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [caseId, revision.revision, JSON.stringify(revision), revision.reducedThroughSeq, occurredAt],
      );
      await client.query(
        `UPDATE cases SET state = $2, tier = $3, incident_id = $4, terminal_reason = $5::text,
                          closed_at = CASE WHEN $5::text IS NULL THEN closed_at ELSE $6::timestamptz END
         WHERE id = $1`,
        [caseId, revision.state, revision.tier, revision.incidentId, revision.terminalReason, occurredAt],
      );

      // Cancel-on-terminal, in the same transaction as the terminal write. If
      // this were a separate call, a crash between the two would leave a closed
      // case with live dunning steps still queued against it.
      if (isTerminal(revision.state)) {
        await client.query(
          `UPDATE scheduled_actions
              SET state = 'cancelled', settled_at = $2, lease_owner = NULL, lease_expiry = NULL
            WHERE case_id = $1 AND state IN ('pending','leased')`,
          [caseId, occurredAt],
        );
      }

      return { stored, revision };
    });
  }

  async #readAll(caseId: CaseId, client?: PoolClient): Promise<StoredCaseEvent[]> {
    const q = client ?? getPool();
    const { rows } = await q.query<{
      seq: string;
      payload: CaseEvent;
      source: string;
      occurred_at: Date;
    }>("SELECT seq, payload, source, occurred_at FROM case_events WHERE case_id = $1 ORDER BY seq", [
      caseId,
    ]);
    return rows.map((r) => ({
      caseId,
      seq: Number(r.seq),
      event: r.payload,
      source: r.source,
      occurredAt: r.occurred_at,
    }));
  }

  readAll(caseId: CaseId): Promise<StoredCaseEvent[]> {
    return this.#readAll(caseId);
  }

  /** Replay from the log. Must reproduce the stored revision exactly. */
  async replay(caseId: CaseId): Promise<CaseRevision> {
    return reduceAll(caseId, await this.#readAll(caseId));
  }
}
