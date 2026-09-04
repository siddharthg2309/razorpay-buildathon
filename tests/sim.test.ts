import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { generateCohort, loadScenario, parseScenario, runBatch, World, renderReport, type BatchReport } from "@rra/sim";

const config = loadConfig();
const scenario = loadScenario("scenarios/demo.yaml");

/** A small cohort so the integration test stays fast but stays real. */
const small = { ...scenario, size: 300 };

const TRUNCATE = `TRUNCATE claim_cache, attribution_runs, incident_members, incidents,
    segment_windows, segment_baselines, promises_to_pay, checkout_sessions, settlements,
    action_attempts, token_burns, capability_tokens, policy_decisions, contact_budgets,
    claims, agent_runs, scheduled_actions, obligation_locks, case_revisions, case_events,
    evidence, ledger, cases, obligations, customers, merchants CASCADE`;

const wipe = () => getPool().query(TRUNCATE);

/**
 * One shared batch for everything that inspects an ordinary run.
 *
 * Ten separate runs of the same 300-case scenario were being made to assert ten
 * different properties of what is, by construction, the same run. Sharing it
 * costs nothing in coverage and takes most of the time out of the suite. Tests
 * that genuinely need a different world still run their own.
 */
let shared: BatchReport;

beforeAll(async () => {
  await wipe();
  shared = await runBatch({ scenario: small, arm: "full", provider: null });
}, 120_000);

afterAll(async () => { await closePool(); });

describe("scenario", () => {
  it("rejects a distribution that does not sum to 1", () => {
    expect(() =>
      parseScenario(`seed: 1
merchant: m
cohort:
  size: 10
  domains: { payment_failure: 0.5 }
  rails: { card: 1.0 }
  causes: { insufficient_funds: 1.0 }
  value_distribution: { mu: 7, sigma: 1 }
world: { natural_recovery_rate: 0.1, responds_to_link: 0.3, funds_clear_after_hours: 48, opt_out_rate: 0, dispute_rate: 0 }
holdout: 0.2
measurement: { window_days: 14, natural_recovery_window_minutes: 30 }
`),
    ).toThrow(/domains distribution sums to 0.5/);
  });
});

describe("cohort generation", () => {
  it("is deterministic for a seed", () => {
    const a = generateCohort(small, config.taxonomy);
    const b = generateCohort(small, config.taxonomy);
    expect(a).toEqual(b);
  });

  it("never produces a (rail, code) pair the taxonomy cannot classify", () => {
    for (const c of generateCohort(scenario, config.taxonomy)) {
      if (c.cause === "unmapped_code") {
        // The deliberate Tier 1 slice: an issuer code we have never seen.
        expect(config.taxonomy.classify(c.rail, c.code)).toBeNull();
      } else {
        expect(config.taxonomy.classify(c.rail, c.code)).not.toBeNull();
      }
    }
  });

  it("keeps the unmapped slice near its configured share", () => {
    const cohort = generateCohort(scenario, config.taxonomy);
    const unmapped = cohort.filter((c) => c.cause === "unmapped_code").length / cohort.length;
    expect(unmapped).toBeGreaterThan(0.03);
    expect(unmapped).toBeLessThan(0.08);
  });

  it("gives roughly the configured share a natural-recovery flag", () => {
    const cohort = generateCohort(scenario, config.taxonomy);
    const share = cohort.filter((c) => c.latent.willPayRegardless).length / cohort.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.21);
  });
});

describe("world", () => {
  it("drains events in order and only once", () => {
    const cohort = generateCohort(small, config.taxonomy);
    const world = new World(cohort, scenario.injections, scenario.seed);
    const first = world.drainUntil(86_400_000);
    const second = world.drainUntil(86_400_000);
    expect(second).toHaveLength(0);
    expect(first.every((e, i) => i === 0 || e.atMs >= first[i - 1]!.atMs)).toBe(true);
  });

  it("applies a degradation only inside its window and segment", () => {
    const cohort = generateCohort(small, config.taxonomy);
    const world = new World(cohort, scenario.injections, scenario.seed);
    const target = { ...cohort[0]!, gateway: "A", issuer: "HDFC", rail: "card" as const };
    const other = { ...cohort[0]!, gateway: "B", issuer: "HDFC", rail: "card" as const };

    // Read the window from the scenario rather than hardcoding it — the last
    // time these drifted apart the test failed for a reason that had nothing
    // to do with the code it was guarding.
    const inj = scenario.injections[0]!;
    const HOUR = 3_600_000;
    const mid = (inj.atHours + inj.durationMinutes / 120) * HOUR;
    const after = (inj.atHours + inj.durationMinutes / 60 + 1) * HOUR;

    expect(world.degradedAt(mid, target)).not.toBeNull();
    expect(world.degradedAt(after, target)).toBeNull();          // window closed
    expect(world.degradedAt(mid, other)).toBeNull();             // different gateway
  });
});

describe("batch runner", () => {
  it("runs a cohort end to end and produces a defensible number", () => {
    const report = shared;

    expect(report.cases).toBe(300);
    // Every case reaches a terminal state — none left mid-flight.
    const terminal = Object.values(report.terminalStates).reduce((a, b) => a + b, 0);
    expect(terminal).toBe(300);
    expect(report.terminalStates["DETECTED"]).toBeUndefined();

    // The ladder holds: Tier 0 carries the overwhelming majority.
    const tierTotal = report.tier0Resolved + report.tier1Escalated;
    expect(report.tier0Resolved / tierTotal).toBeGreaterThan(0.85);

    // No step died from an unexpected error.
    expect(report.stepErrors).toBe(0);

    // The agent moved the number, and the interval covers the truth.
    expect(report.attribution.lift).toBeGreaterThan(0);
    expect(report.attribution.holdoutN).toBeGreaterThan(0);
    expect(report.intervalContainsTruth).toBe(true);

    // Gross is always at least incremental — conflating them is the failure
    // mode the whole attribution service exists to avoid.
    expect(report.attribution.grossRecoveredPaise).toBeGreaterThanOrEqual(
      report.attribution.incrementalPaise,
    );
  });

  it("produces identical output for the same seed", async () => {
    // Re-runs against the shared one. The second run reproduces the first
    // byte for byte, so it leaves the database in the state the other tests
    // expect and no restoration is needed.
    const first = shared;
    await wipe();
    const second = await runBatch({ scenario: small, arm: "full", provider: null });

    expect(second.attribution.treatedN).toBe(first.attribution.treatedN);
    expect(second.attribution.treatedRecovered).toBe(first.attribution.treatedRecovered);
    expect(second.attribution.incrementalPaise).toBe(first.attribution.incrementalPaise);
    expect(second.trueIncrementalPaise).toBe(first.trueIncrementalPaise);
    expect(second.terminalStates).toEqual(first.terminalStates);
  }, 180_000);

  it("escalates rather than dropping cases when no provider is available", () => {
    const report = shared;
    // The unmapped slice reaches Tier 1 and, with no provider, must escalate —
    // a model outage may not silently discard the case.
    expect(report.tier1Escalated).toBeGreaterThan(0);
    expect(report.degradedEscalations).toBe(report.tier1Escalated);
  });

  it("persists the run for the console to read back", async () => {
    const { rows } = await getPool().query<{ arm: string; treated_n: number }>(
      "SELECT arm, treated_n FROM attribution_runs",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.arm).toBe("full");
  });

  it("renders a report a judge can read without narration", () => {
    const text = renderReport(shared);
    expect(text).toContain("GROSS");
    expect(text).toContain("EST. INCREMENTAL");
    expect(text).toContain("TRUE (SIM)");
    expect(text).toContain("interval contains ground truth");
  });
});

describe("the agentic machinery actually runs", () => {
  /**
   * These assert exercise, not existence.
   *
   * Every mechanism below was built and unit-tested and then ran zero times in
   * the demo batch, because the scenario never produced the workload it needed.
   * A component that only works in its own test is not part of the product.
   */
  it("exercises the optimizer, reactive loop and intent path on a real batch", async () => {
    const report = shared;

    // Explainable next-best action, on every case rather than the Tier 1 few.
    expect(report.optimizerDecisions).toBeGreaterThan(0);

    // The reactive loop: a reply is new evidence, and exactly the roles that
    // declared a dependency on customer facts get invalidated.
    expect(report.repliesInterpreted).toBeGreaterThan(0);
    const { rows: invalidated } = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM claims WHERE status = 'invalidated'",
    );
    expect(Number(invalidated[0]!.n)).toBeGreaterThan(0);

    // The mandate sequencer decides ordering on the rails that carry one.
    expect(report.mandateSequences).toBeGreaterThan(0);
  });

  it("never lets a quiet-hours block silently end a case", async () => {
    // The previous version asserted deferrals >= 0, which is true of any
    // number and therefore checked nothing. What matters is that a deferred
    // case goes somewhere: it either gets contacted once contact is allowed,
    // or it reaches a terminal state. Stalling forever is the failure.
    const { rows } = await getPool().query<{ stalled: string }>(
      `WITH deferred AS (
         SELECT DISTINCT case_id FROM ledger WHERE event_type = 'deferred_for_quiet_hours'
       )
       SELECT count(*) AS stalled FROM deferred d JOIN cases c ON c.id = d.case_id
        WHERE c.closed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM action_attempts a
             WHERE a.case_id = d.case_id AND a.sent_at > (
               SELECT min(l.ts) FROM ledger l
                WHERE l.case_id = d.case_id AND l.event_type = 'deferred_for_quiet_hours')
          )`,
    );
    expect(Number(rows[0]!.stalled)).toBe(0);
    expect(shared.stepErrors).toBe(0);
  });

  it("sends no contact inside quiet hours, whatever the deferral count", async () => {
    // The compliance property itself, rather than a count of deferrals.
    const { rows } = await getPool().query<{ ist_hour: string }>(
      `SELECT DISTINCT to_char(a.sent_at AT TIME ZONE 'Asia/Kolkata', 'HH24') AS ist_hour
         FROM action_attempts a
        WHERE a.action_id IN ('send_approved_template', 'place_approved_voice_call')`,
    );
    for (const r of rows) {
      const hour = Number(r.ist_hour);
      expect(hour >= 9 && hour < 21).toBe(true);
    }
  });

  it("records promises as evidence and resumes collection when they break", async () => {
    const { rows } = await getPool().query<{ state: string; n: string }>(
      "SELECT state, count(*) AS n FROM promises_to_pay GROUP BY state",
    );
    const byState = Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
    expect((byState["kept"] ?? 0) + (byState["broken"] ?? 0)).toBeGreaterThan(0);

    // A promise never closes a case on its own — only matched money does.
    const { rows: bad } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM cases c
        WHERE c.state = 'RECOVERED'
          AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.obligation_id = c.obligation_id)`,
    );
    expect(Number(bad[0]!.n)).toBe(0);
  });
});

describe("repeated customer replies", () => {
  it("does not collide when a customer answers twice in the same tick", async () => {
    // Keying reply evidence on the tick made a second reply within the hour a
    // primary-key collision, which killed the entire batch rather than the case.
    const chatty = {
      ...small,
      seed: 4242,
      world: { ...small.world, replyRate: 0.9 },
    };
    await wipe();
    await expect(runBatch({ scenario: chatty, arm: "full", provider: null }))
      .resolves.toBeDefined();
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM evidence WHERE kind = 'customer_reply'",
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  }, 180_000);
});
