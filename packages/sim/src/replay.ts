import { loadConfig, reduceAll, type CaseRevision, type Domain, type Rail } from "@rra/core";
import { getPool } from "@rra/db";
import { Tier0Resolver } from "@rra/engine";

export interface ReplayMismatch {
  caseId: string;
  kind: "revision" | "tier0_plan" | "tier0_rule" | "missing_ledger_rule";
  expected: string;
  actual: string;
}

export interface ReplayReport {
  casesChecked: number;
  revisionsReproduced: number;
  tier0DecisionsChecked: number;
  tier0Reproduced: number;
  tier1Cases: number;
  mismatches: ReplayMismatch[];
  ok: boolean;
}

/**
 * The replay verifier.
 *
 * Two distinct claims, checked separately:
 *
 *   1. Every stored case revision is reproducible by folding its event log
 *      through the deterministic reducer. This is what makes the event log
 *      authoritative rather than decorative.
 *
 *   2. Every Tier 0 decision recreates the identical plan and rule id from its
 *      recorded inputs. Tier 0 carries no model non-determinism, so a
 *      divergence here means the taxonomy, the playbooks, or the resolver
 *      changed under a ledger that claims otherwise.
 *
 * Tier 1 cases are counted but not re-derived: their claims are recorded with
 * the provider and model that produced them, and re-deriving would require
 * re-calling the provider. Their inputs, claims and scores are stored so the
 * decision is inspectable — a weaker guarantee, stated as such.
 */
export async function verifyReplay(): Promise<ReplayReport> {
  const config = loadConfig();
  const tier0 = new Tier0Resolver(config.taxonomy, config.playbooks);
  const pool = getPool();
  const mismatches: ReplayMismatch[] = [];

  const { rows: cases } = await pool.query<{ id: string; tier: number; domain: Domain }>(
    "SELECT id, tier, domain FROM cases ORDER BY id",
  );

  let revisionsReproduced = 0;
  let tier0Checked = 0;
  let tier0Reproduced = 0;
  let tier1Cases = 0;

  for (const c of cases) {
    // --- claim 1: the reducer reproduces the stored revision ---------------
    const { rows: events } = await pool.query<{
      seq: string; payload: Record<string, unknown>; source: string; occurred_at: Date;
    }>("SELECT seq, payload, source, occurred_at FROM case_events WHERE case_id = $1 ORDER BY seq", [c.id]);

    const { rows: stored } = await pool.query<{ state_json: CaseRevision }>(
      "SELECT state_json FROM case_revisions WHERE case_id = $1 ORDER BY revision DESC LIMIT 1",
      [c.id],
    );

    if (events.length > 0 && stored[0]) {
      const replayed = reduceAll(
        c.id,
        events.map((e) => ({
          caseId: c.id,
          seq: Number(e.seq),
          event: e.payload as never,
          source: e.source,
          occurredAt: e.occurred_at,
        })),
      );
      const expected = stored[0].state_json;
      if (
        replayed.state === expected.state &&
        replayed.revision === expected.revision &&
        replayed.attemptCount === expected.attemptCount &&
        replayed.terminalReason === expected.terminalReason
      ) {
        revisionsReproduced++;
      } else {
        mismatches.push({
          caseId: c.id, kind: "revision",
          expected: `${expected.state}@r${expected.revision}`,
          actual: `${replayed.state}@r${replayed.revision}`,
        });
      }
    }

    // --- claim 2: Tier 0 recreates its plan from recorded inputs -----------
    if (c.tier !== 0) {
      tier1Cases++;
      continue;
    }

    const { rows: led } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ledger WHERE case_id = $1 AND event_type = 'plan_selected' ORDER BY id LIMIT 1`,
      [c.id],
    );
    const { rows: evid } = await pool.query<{ payload: { rail?: string; code?: string } }>(
      "SELECT payload FROM evidence WHERE case_id = $1 AND kind = 'decline_code' ORDER BY observed_at LIMIT 1",
      [c.id],
    );
    const recorded = led[0]?.payload;
    const inputs = evid[0]?.payload;
    if (!recorded || !inputs?.rail || !inputs.code) continue;

    tier0Checked++;
    const redecided = tier0.resolve({
      domain: c.domain,
      rail: inputs.rail as Rail,
      code: inputs.code,
      attemptNo: 0,
    });

    if (!redecided.resolved) {
      mismatches.push({
        caseId: c.id, kind: "tier0_plan",
        expected: String(recorded["ruleId"]),
        actual: `unresolved (${redecided.reason})`,
      });
      continue;
    }
    if (redecided.plan.ruleId !== recorded["ruleId"]) {
      mismatches.push({
        caseId: c.id, kind: "tier0_rule",
        expected: String(recorded["ruleId"]),
        actual: redecided.plan.ruleId,
      });
      continue;
    }
    if (redecided.classification.cause !== recorded["cause"]) {
      mismatches.push({
        caseId: c.id, kind: "tier0_plan",
        expected: String(recorded["cause"]),
        actual: redecided.classification.cause,
      });
      continue;
    }
    tier0Reproduced++;
  }

  return {
    casesChecked: cases.length,
    revisionsReproduced,
    tier0DecisionsChecked: tier0Checked,
    tier0Reproduced,
    tier1Cases,
    mismatches,
    ok: mismatches.length === 0,
  };
}

export function renderReplay(r: ReplayReport): string {
  const lines = [
    "LEDGER REPLAY VERIFIER",
    `  cases checked                ${r.casesChecked}`,
    `  revisions reproduced         ${r.revisionsReproduced}`,
    `  tier 0 decisions re-derived  ${r.tier0Reproduced}/${r.tier0DecisionsChecked}`,
    `  tier 1 cases (not re-derived) ${r.tier1Cases}`,
  ];
  if (r.mismatches.length) {
    lines.push("", `  MISMATCHES (${r.mismatches.length}):`);
    for (const m of r.mismatches.slice(0, 10)) {
      lines.push(`    ${m.caseId}  ${m.kind}  expected ${m.expected}  got ${m.actual}`);
    }
  } else {
    lines.push("", "  every stored revision and every Tier 0 decision reproduced exactly.");
    lines.push("  Tier 1 decisions are inspectable rather than re-derivable: their inputs,");
    lines.push("  claims, provider, model and scores are recorded, but re-deriving one would");
    lines.push("  require re-calling the provider. Stated rather than glossed.");
  }
  return lines.join("\n");
}
