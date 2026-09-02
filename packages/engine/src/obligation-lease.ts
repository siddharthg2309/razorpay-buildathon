import type { PoolClient } from "pg";
import type { Clock } from "@rra/core";
import { getPool } from "@rra/db";

export class LeaseUnavailableError extends Error {
  constructor(obligationId: string, heldBy: string) {
    super(`obligation ${obligationId} is leased by ${heldBy}`);
    this.name = "LeaseUnavailableError";
  }
}

/**
 * The obligation is the unit of money, so the lease is keyed on it rather than
 * on the case: several cases and an incident may all reference one obligation,
 * and exactly one may act.
 *
 * Acquire at execution admission. Holding a lease across deliberation would let
 * a slow specialist block the obligation, and an expiring lease mid-provider-
 * call is precisely the race that double-charges.
 */
export class ObligationLease {
  constructor(
    private readonly clock: Clock,
    private readonly ttlMs = 60_000,
  ) {}

  /** Returns false rather than throwing when another holder is live. */
  async tryAcquire(obligationId: string, holder: string, client?: PoolClient): Promise<boolean> {
    const q = client ?? getPool();
    const now = this.clock.now();
    const expiry = new Date(now.getTime() + this.ttlMs);
    const { rowCount } = await q.query(
      `INSERT INTO obligation_locks (obligation_id, holder, acquired_at, expiry)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (obligation_id) DO UPDATE
         SET holder = $2, acquired_at = $3, expiry = $4
         WHERE obligation_locks.expiry <= $3 OR obligation_locks.holder = $2`,
      [obligationId, holder, now, expiry],
    );
    return (rowCount ?? 0) > 0;
  }

  async acquire(obligationId: string, holder: string, client?: PoolClient): Promise<void> {
    if (await this.tryAcquire(obligationId, holder, client)) return;
    const { rows } = await (client ?? getPool()).query<{ holder: string }>(
      "SELECT holder FROM obligation_locks WHERE obligation_id = $1",
      [obligationId],
    );
    throw new LeaseUnavailableError(obligationId, rows[0]?.holder ?? "unknown");
  }

  async release(obligationId: string, holder: string, client?: PoolClient): Promise<void> {
    await (client ?? getPool()).query(
      "DELETE FROM obligation_locks WHERE obligation_id = $1 AND holder = $2",
      [obligationId, holder],
    );
  }

  /** Run fn under the lease, releasing it even if fn throws. */
  async withLease<T>(obligationId: string, holder: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(obligationId, holder);
    try {
      return await fn();
    } finally {
      await this.release(obligationId, holder);
    }
  }
}
