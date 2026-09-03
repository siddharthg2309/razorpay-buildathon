import type { PoolClient } from "pg";
import type { Clock } from "@rra/core";
import { getPool, withTransaction } from "@rra/db";

export interface ActionRef {
  actionId: string;
  params: Record<string, unknown>;
  attemptNo: number;
}

export interface ScheduledAction {
  id: number;
  caseId: string;
  obligationId: string;
  fireAt: Date;
  actionRef: ActionRef;
  attempts: number;
}

export interface ScheduleRequest {
  caseId: string;
  obligationId: string;
  fireAt: Date;
  actionRef: ActionRef;
}

/**
 * Durable scheduler.
 *
 * Leased dispatch, not exactly-once I/O. Lease acquisition and terminal writes
 * are transactional, but the external call a leased row triggers is
 * at-least-once and must carry its own idempotency key. After a crash, an
 * in-flight attempt is reconciled before it can be retried.
 */
export class Scheduler {
  constructor(
    private readonly clock: Clock,
    /** How long a worker may hold a leased row before it is reclaimable. */
    private readonly leaseMs = 30_000,
  ) {}

  async schedule(req: ScheduleRequest, client?: PoolClient): Promise<number> {
    const q = client ?? getPool();
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO scheduled_actions (case_id, obligation_id, fire_at, action_ref, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.caseId, req.obligationId, req.fireAt, JSON.stringify(req.actionRef), this.clock.now()],
    );
    return Number(rows[0]!.id);
  }

  /**
   * Lease every due row, skipping rows another worker already holds.
   *
   * FOR UPDATE SKIP LOCKED is what makes concurrent tick workers safe: two
   * workers ticking at once split the due set rather than both claiming it.
   */
  async tick(owner: string, limit = 50): Promise<ScheduledAction[]> {
    const now = this.clock.now();
    const leaseExpiry = new Date(now.getTime() + this.leaseMs);

    return withTransaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        case_id: string;
        obligation_id: string;
        fire_at: Date;
        action_ref: ActionRef;
        attempts: number;
      }>(
        `SELECT id, case_id, obligation_id, fire_at, action_ref, attempts
           FROM scheduled_actions
          WHERE state = 'pending' AND fire_at <= $1
          -- case_id before id. Rows get their BIGSERIAL in insert order, and
          -- once cases are planned concurrently that order varies between runs,
          -- which changes which action fires first within a tick and makes the
          -- whole batch irreproducible. case_id is stable.
          ORDER BY fire_at, case_id, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [now, limit],
      );
      if (rows.length === 0) return [];

      const ids = rows.map((r) => Number(r.id));
      await client.query(
        `UPDATE scheduled_actions
            SET state = 'leased', lease_owner = $2, lease_expiry = $3, attempts = attempts + 1
          WHERE id = ANY($1::bigint[])`,
        [ids, owner, leaseExpiry],
      );

      return rows.map((r) => ({
        id: Number(r.id),
        caseId: r.case_id,
        obligationId: r.obligation_id,
        fireAt: r.fire_at,
        actionRef: r.action_ref,
        attempts: r.attempts + 1,
      }));
    });
  }

  async complete(id: number, client?: PoolClient): Promise<void> {
    const q = client ?? getPool();
    await q.query(
      `UPDATE scheduled_actions SET state = 'done', settled_at = $2, lease_owner = NULL, lease_expiry = NULL
        WHERE id = $1 AND state = 'leased'`,
      [id, this.clock.now()],
    );
  }

  /** Return a leased row to pending so a later tick picks it up again. */
  async release(id: number): Promise<void> {
    await getPool().query(
      `UPDATE scheduled_actions SET state = 'pending', lease_owner = NULL, lease_expiry = NULL
        WHERE id = $1 AND state = 'leased'`,
      [id],
    );
  }

  /**
   * Reclaim rows whose worker died holding the lease. Attempts is not reset —
   * a row that keeps crashing its worker stays visible as such.
   */
  async reclaimExpiredLeases(): Promise<number> {
    const { rowCount } = await getPool().query(
      `UPDATE scheduled_actions SET state = 'pending', lease_owner = NULL, lease_expiry = NULL
        WHERE state = 'leased' AND lease_expiry <= $1`,
      [this.clock.now()],
    );
    return rowCount ?? 0;
  }

  /**
   * Cancel everything still outstanding for a case. Called inside the same
   * transaction as the terminal write — this is how a payment that succeeds on
   * its own stops the rest of the dunning sequence.
   */
  async cancelForCase(caseId: string, client?: PoolClient): Promise<number> {
    const q = client ?? getPool();
    const { rowCount } = await q.query(
      `UPDATE scheduled_actions SET state = 'cancelled', settled_at = $2, lease_owner = NULL, lease_expiry = NULL
        WHERE case_id = $1 AND state IN ('pending','leased')`,
      [caseId, this.clock.now()],
    );
    return rowCount ?? 0;
  }

  async pendingCount(caseId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM scheduled_actions
        WHERE case_id = $1 AND state IN ('pending','leased')`,
      [caseId],
    );
    return Number(rows[0]!.n);
  }
}
