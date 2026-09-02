import type { PoolClient } from "pg";
import type { Clock, EvidenceKind, RoleId } from "@rra/core";
import { getPool, withTransaction } from "@rra/db";

export interface ClaimRecord {
  id: string;
  caseId: string;
  revision: number;
  role: RoleId;
  status: "valid" | "invalidated";
  confidence: number | null;
  payload: Record<string, unknown>;
  evidenceRefs: readonly string[];
}

export interface WriteClaim {
  id: string;
  caseId: string;
  revision: number;
  role: RoleId;
  confidence?: number;
  payload: Record<string, unknown>;
  evidenceRefs?: readonly string[];
  agentRunId?: string;
}

export interface WriteEvidence {
  id: string;
  caseId: string;
  kind: EvidenceKind;
  payload: Record<string, unknown>;
  source: string;
}

/**
 * The shared case blackboard: append-only evidence plus versioned claims.
 *
 * Specialists read here and write claims here. They never call each other, so
 * there is no conversation to pass along — the blackboard is the only channel.
 */
export class Blackboard {
  constructor(private readonly clock: Clock) {}

  async addEvidence(e: WriteEvidence, client?: PoolClient): Promise<void> {
    await (client ?? getPool()).query(
      `INSERT INTO evidence (id, case_id, kind, payload, source, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.id, e.caseId, e.kind, JSON.stringify(e.payload), e.source, this.clock.now()],
    );
  }

  async evidenceFor(caseId: string, kinds?: readonly EvidenceKind[]): Promise<
    { id: string; kind: EvidenceKind; payload: Record<string, unknown>; source: string }[]
  > {
    const { rows } = await getPool().query<{
      id: string;
      kind: EvidenceKind;
      payload: Record<string, unknown>;
      source: string;
    }>(
      kinds?.length
        ? `SELECT id, kind, payload, source FROM evidence
            WHERE case_id = $1 AND kind = ANY($2::text[]) ORDER BY observed_at, id`
        : `SELECT id, kind, payload, source FROM evidence WHERE case_id = $1 ORDER BY observed_at, id`,
      kinds?.length ? [caseId, kinds] : [caseId],
    );
    return rows;
  }

  /**
   * Writes a claim, replacing this role's live claim atomically. The old row is
   * marked invalidated rather than deleted — the audit trail needs to show that
   * a claim existed and was superseded.
   */
  async writeClaim(c: WriteClaim): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE claims SET status = 'invalidated', invalidated_at = $3
          WHERE case_id = $1 AND role = $2 AND status = 'valid'`,
        [c.caseId, c.role, this.clock.now()],
      );
      await client.query(
        `INSERT INTO claims (id, case_id, revision, agent_run_id, role, confidence, payload, evidence_refs, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          c.id,
          c.caseId,
          c.revision,
          c.agentRunId ?? null,
          c.role,
          c.confidence ?? null,
          JSON.stringify(c.payload),
          c.evidenceRefs ?? [],
          this.clock.now(),
        ],
      );
    });
  }

  async liveClaims(caseId: string): Promise<ClaimRecord[]> {
    const { rows } = await getPool().query<{
      id: string;
      case_id: string;
      revision: string;
      role: RoleId;
      status: "valid" | "invalidated";
      confidence: number | null;
      payload: Record<string, unknown>;
      evidence_refs: string[];
    }>(
      `SELECT id, case_id, revision, role, status, confidence, payload, evidence_refs
         FROM claims WHERE case_id = $1 AND status = 'valid' ORDER BY role`,
      [caseId],
    );
    return rows.map((r) => ({
      id: r.id,
      caseId: r.case_id,
      revision: Number(r.revision),
      role: r.role,
      status: r.status,
      confidence: r.confidence,
      payload: r.payload,
      evidenceRefs: r.evidence_refs,
    }));
  }

  /** Invalidate the live claims of the named roles. Returns how many fell. */
  async invalidateRoles(caseId: string, roles: readonly RoleId[]): Promise<number> {
    if (roles.length === 0) return 0;
    const { rowCount } = await getPool().query(
      `UPDATE claims SET status = 'invalidated', invalidated_at = $3
        WHERE case_id = $1 AND role = ANY($2::text[]) AND status = 'valid'`,
      [caseId, roles, this.clock.now()],
    );
    return rowCount ?? 0;
  }

  async recordRun(run: {
    id: string;
    caseId: string;
    revision: number;
    role: RoleId;
    status: "ok" | "timeout" | "error" | "skipped";
    inputHash: string;
    provider?: string;
    model?: string;
    latencyMs?: number;
    costPaise?: number;
  }): Promise<void> {
    const now = this.clock.now();
    await getPool().query(
      `INSERT INTO agent_runs (id, case_id, revision, role, status, input_hash, provider, model, latency_ms, cost_paise, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [
        run.id, run.caseId, run.revision, run.role, run.status, run.inputHash,
        run.provider ?? null, run.model ?? null, run.latencyMs ?? null, run.costPaise ?? null, now,
      ],
    );
  }
}
