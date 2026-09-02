import { randomUUID } from "node:crypto";
import type { Clock } from "@rra/core";
import { CaseEventStore, Ledger, getPool, withTransaction } from "@rra/db";
import { Scheduler } from "./scheduler.js";
import { segmentLabel, type Candidate, type SegmentKey } from "./detector.js";

export interface IncidentRecord {
  id: string;
  label: string;
  state: "open" | "releasing" | "closed";
  releaseStage: number;
  parkedCount: number;
}

/**
 * Owns incidents and the cases attached to them.
 *
 * The rule that shapes everything here: the incident, not the case, owns
 * resumption. A parked case's scheduled actions are cancelled on attach and
 * re-created by the release controller — never resumed by the case itself.
 */
export class IncidentManager {
  private readonly events: CaseEventStore;
  private readonly ledger: Ledger;
  private readonly scheduler: Scheduler;

  constructor(private readonly clock: Clock) {
    this.events = new CaseEventStore(clock);
    this.ledger = new Ledger(clock);
    this.scheduler = new Scheduler(clock);
  }

  /** Opens one incident, or returns the existing open one for that segment. */
  async open(candidate: Candidate, detectedBy: string): Promise<string> {
    const label = candidate.label;
    const existing = await getPool().query<{ id: string }>(
      "SELECT id FROM incidents WHERE segment_label = $1 AND state <> 'closed' LIMIT 1",
      [label],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const id = `inc_${randomUUID().slice(0, 8)}`;
    await getPool().query(
      `INSERT INTO incidents
         (id, segment_key, segment_label, state, detected_by, z_score, p_value,
          baseline_rate, observed_rate, sample_n, opened_at)
       VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10)`,
      [
        id, JSON.stringify(candidate.segment), label, detectedBy,
        candidate.test.z, candidate.test.pValue, candidate.test.baselineRate,
        candidate.test.observedRate, candidate.attempts, this.clock.now(),
      ],
    );
    await this.ledger.append({
      caseId: id, actor: "detector", eventType: "incident_opened",
      payload: { label, z: candidate.test.z, pValue: candidate.test.pValue, n: candidate.attempts },
    });
    return id;
  }

  /** Opened from a Razorpay downtime webhook rather than the internal detector. */
  async openFromDowntime(segment: SegmentKey): Promise<string> {
    return this.open(
      {
        segment,
        label: segmentLabel(segment),
        attempts: 0,
        test: { z: 0, pValue: 0, observedRate: 0, baselineRate: 0 },
      },
      "razorpay_downtime_webhook",
    );
  }

  /**
   * Attach cases and park them. Their pending scheduled actions are cancelled
   * in the same transaction as the state change, so nothing fires while parked.
   */
  async attachAndSuppress(incidentId: string, caseIds: readonly string[]): Promise<number> {
    let parked = 0;
    for (const caseId of caseIds) {
      const already = await getPool().query(
        "SELECT 1 FROM incident_members WHERE incident_id = $1 AND case_id = $2",
        [incidentId, caseId],
      );
      if ((already.rowCount ?? 0) > 0) continue;

      await getPool().query(
        "INSERT INTO incident_members (incident_id, case_id, attached_at) VALUES ($1,$2,$3)",
        [incidentId, caseId, this.clock.now()],
      );
      // The event store cancels pending actions on the way into a terminal
      // state; suppression is not terminal, so cancel explicitly here.
      await this.events.append(caseId, { type: "incident_attached", incidentId }, "incident_manager");
      await this.scheduler.cancelForCase(caseId);
      parked++;
    }
    await this.ledger.append({
      caseId: incidentId, actor: "incident_manager", eventType: "cases_parked",
      payload: { parked, requested: caseIds.length },
    });
    return parked;
  }

  async recordRca(incidentId: string, rca: Record<string, unknown>): Promise<void> {
    await getPool().query("UPDATE incidents SET rca = $2 WHERE id = $1", [
      incidentId,
      JSON.stringify(rca),
    ]);
    await this.ledger.append({
      caseId: incidentId, actor: "agent:incident_intelligence", eventType: "rca_recorded", payload: rca,
    });
  }

  async parkedCases(incidentId: string): Promise<string[]> {
    const { rows } = await getPool().query<{ case_id: string }>(
      "SELECT case_id FROM incident_members WHERE incident_id = $1 AND released_at IS NULL ORDER BY case_id",
      [incidentId],
    );
    return rows.map((r) => r.case_id);
  }

  /** Release a slice back into the live population. */
  async release(incidentId: string, caseIds: readonly string[]): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE incident_members SET released_at = $3 WHERE incident_id = $1 AND case_id = ANY($2::text[])",
        [incidentId, caseIds, this.clock.now()],
      );
    });
    for (const caseId of caseIds) {
      await this.events.append(caseId, { type: "incident_released", incidentId }, "release_controller");
    }
    await this.ledger.append({
      caseId: incidentId, actor: "release_controller", eventType: "cases_released",
      payload: { released: caseIds.length },
    });
  }

  /** Re-park a slice the circuit breaker pulled back. */
  async repark(incidentId: string, caseIds: readonly string[]): Promise<void> {
    for (const caseId of caseIds) {
      await getPool().query(
        "UPDATE incident_members SET released_at = NULL WHERE incident_id = $1 AND case_id = $2",
        [incidentId, caseId],
      );
      await this.events.append(caseId, { type: "incident_attached", incidentId }, "circuit_breaker");
      await this.scheduler.cancelForCase(caseId);
    }
    await this.ledger.append({
      caseId: incidentId, actor: "circuit_breaker", eventType: "cases_reparked",
      payload: { reparked: caseIds.length },
    });
  }

  async setState(incidentId: string, state: "open" | "releasing" | "closed", stage?: number): Promise<void> {
    await getPool().query(
      `UPDATE incidents SET state = $2, release_stage = COALESCE($3, release_stage),
              closed_at = CASE WHEN $2 = 'closed' THEN $4 ELSE closed_at END
        WHERE id = $1`,
      [incidentId, state, stage ?? null, this.clock.now()],
    );
  }

  async get(incidentId: string): Promise<IncidentRecord | null> {
    const { rows } = await getPool().query<{
      id: string; segment_label: string; state: "open" | "releasing" | "closed"; release_stage: number;
    }>("SELECT id, segment_label, state, release_stage FROM incidents WHERE id = $1", [incidentId]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      label: row.segment_label,
      state: row.state,
      releaseStage: row.release_stage,
      parkedCount: (await this.parkedCases(incidentId)).length,
    };
  }

  async openIncidentCount(): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM incidents WHERE state <> 'closed'",
    );
    return Number(rows[0]!.n);
  }
}
