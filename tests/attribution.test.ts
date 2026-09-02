import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { VirtualClock } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { CaseManager } from "@rra/engine";
import {
  DEFAULT_ESTIMATOR_CONFIG, assignHoldout, balance, estimate, mulberry32,
  stratumOf, trueIncremental, valueBand, type CaseOutcome,
} from "@rra/attribution";

const T0 = new Date("2026-09-02T09:00:00Z");

function cohort(n: number, seed = 20260902) {
  const rand = mulberry32(seed);
  const causes = ["insufficient_funds", "expired_card", "mandate_revoked", "gateway_timeout"];
  return Array.from({ length: n }, (_, i) => ({
    caseId: `c_${String(i).padStart(4, "0")}`,
    cause: causes[Math.floor(rand() * causes.length)]!,
    amountPaise: Math.round(Math.exp(7.6 + rand() * 0.9) * 100),
  }));
}

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE attribution_runs, incident_members, incidents, settlements, action_attempts, token_burns, capability_tokens, policy_decisions, contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE",
  );
});
afterAll(async () => { await closePool(); });

describe("holdout assignment", () => {
  it("bands values so the holdout cannot skew cheap", () => {
    expect(valueBand(50_000)).toBe("lt_1k");
    expect(valueBand(420_000)).toBe("1k_5k");
    expect(valueBand(9_999_999)).toBe("gt_25k");
    expect(stratumOf({ caseId: "c", cause: "expired_card", amountPaise: 420_000 }))
      .toBe("expired_card:1k_5k");
  });

  it("is deterministic for a seed and independent of creation order", () => {
    const cases = cohort(200);
    const forward = cases.map((c) => assignHoldout(c, 0.2, 7));
    const backward = [...cases].reverse().map((c) => assignHoldout(c, 0.2, 7)).reverse();
    expect(backward).toEqual(forward);
  });

  it("changes the split when the seed changes", () => {
    const cases = cohort(200);
    const a = cases.map((c) => assignHoldout(c, 0.2, 1));
    const b = cases.map((c) => assignHoldout(c, 0.2, 2));
    expect(a).not.toEqual(b);
  });

  it("lands near the requested rate at batch size", () => {
    const cases = cohort(2000);
    const held = cases.filter((c) => assignHoldout(c, 0.2, 20260902)).length;
    expect(held / cases.length).toBeGreaterThan(0.17);
    expect(held / cases.length).toBeLessThan(0.23);
  });

  it("keeps every stratum represented in both arms", () => {
    const cases = cohort(2000);
    const rows = balance(
      cases.map((c) => ({ stratum: stratumOf(c), holdout: assignHoldout(c, 0.2, 20260902) })),
    );
    for (const r of rows) {
      // Only assert on strata with enough mass to expect both arms populated.
      if (r.treated + r.holdout < 40) continue;
      expect(r.holdout).toBeGreaterThan(0);
      expect(r.treated).toBeGreaterThan(0);
      expect(r.holdoutShare).toBeGreaterThan(0.08);
      expect(r.holdoutShare).toBeLessThan(0.35);
    }
  });

  it("refuses to change a holdout flag once assigned", async () => {
    const clock = new VirtualClock(T0);
    await getPool().query(`INSERT INTO merchants (id,name,policy_version) VALUES ('m_1','A','v7')`);
    await getPool().query(`INSERT INTO customers (id,merchant_id) VALUES ('cu_1','m_1')`);
    await new CaseManager(clock).openOrAttach({
      caseId: "c_h1", merchantId: "m_1", customerId: "cu_1",
      obligationId: "ob_h1", externalRef: "ext_h1", domain: "payment_failure",
      amountPaise: 420_000, dueAt: clock.now(), holdout: true,
    });
    await expect(
      getPool().query("UPDATE cases SET holdout_flag = false WHERE id = 'c_h1'"),
    ).rejects.toThrow(/holdout_flag is immutable/);
  });
});

describe("estimator", () => {
  const outcome = (over: Partial<CaseOutcome>): CaseOutcome => ({
    caseId: "c", holdout: false, recovered: false, amountPaise: 420_000, ...over,
  });

  function synthetic(opts: {
    treatedN: number; holdoutN: number; treatedRate: number; holdoutRate: number;
  }): CaseOutcome[] {
    const out: CaseOutcome[] = [];
    for (let i = 0; i < opts.treatedN; i++) {
      out.push(outcome({
        caseId: `t_${i}`, holdout: false,
        recovered: i < Math.round(opts.treatedN * opts.treatedRate),
        recoveredAfterMs: 86_400_000,
      }));
    }
    for (let i = 0; i < opts.holdoutN; i++) {
      out.push(outcome({
        caseId: `h_${i}`, holdout: true,
        recovered: i < Math.round(opts.holdoutN * opts.holdoutRate),
        recoveredAfterMs: 86_400_000,
      }));
    }
    return out;
  }

  it("reports gross and incremental separately, and never conflates them", () => {
    const r = estimate(synthetic({ treatedN: 320, holdoutN: 80, treatedRate: 0.412, holdoutRate: 0.174 }));
    expect(r.treatedRate).toBeCloseTo(0.412, 2);
    expect(r.holdoutRate).toBeCloseTo(0.175, 2);
    expect(r.lift).toBeCloseTo(0.237, 2);
    // Gross counts every rupee that arrived; incremental only the caused ones.
    expect(r.grossRecoveredPaise).toBeGreaterThan(r.incrementalPaise);
  });

  it("produces a wide interval at a small holdout and a tighter one when powered", () => {
    const small = estimate(synthetic({ treatedN: 320, holdoutN: 80, treatedRate: 0.412, holdoutRate: 0.174 }));
    const large = estimate(synthetic({ treatedN: 1600, holdoutN: 400, treatedRate: 0.412, holdoutRate: 0.174 }));
    const width = (ci: [number, number]) => ci[1] - ci[0];
    expect(width(small.liftCi)).toBeGreaterThan(width(large.liftCi));
    // The n=80 holdout really is around +/-10pp — this is why the batch is 2000.
    expect(width(small.liftCi) / 2).toBeGreaterThan(0.08);
    expect(width(large.liftCi) / 2).toBeLessThan(0.06);
  });

  it("excludes natural recovery from BOTH arms, so the estimate is not inflated", () => {
    // Ten treated and ten holdout cases all recover instantly — nobody caused
    // these. A one-sided exclusion would strip them from treated only and
    // manufacture lift.
    const quick: CaseOutcome[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        outcome({ caseId: `tq_${i}`, holdout: false, recovered: true, recoveredAfterMs: 60_000 })),
      ...Array.from({ length: 10 }, (_, i) =>
        outcome({ caseId: `hq_${i}`, holdout: true, recovered: true, recoveredAfterMs: 60_000 })),
    ];
    const r = estimate([...synthetic({ treatedN: 100, holdoutN: 100, treatedRate: 0.4, holdoutRate: 0.2 }), ...quick]);

    expect(r.excludedTreated).toBe(10);
    expect(r.excludedHoldout).toBe(10);
    // Both arms shed the same instant recoveries, so the lift is unchanged.
    expect(r.lift).toBeCloseTo(0.2, 2);
  });

  it("excludes recoveries the merchant's own dunning collected", () => {
    const r = estimate([
      ...synthetic({ treatedN: 50, holdoutN: 50, treatedRate: 0.4, holdoutRate: 0.2 }),
      outcome({ caseId: "md", holdout: false, recovered: true, merchantDunning: true, recoveredAfterMs: 86_400_000 }),
    ]);
    expect(r.excludedTreated).toBe(1);
    expect(r.treatedN).toBe(50);
  });

  it("reports no lift when the agent changed nothing", () => {
    const r = estimate(synthetic({ treatedN: 500, holdoutN: 500, treatedRate: 0.3, holdoutRate: 0.3 }));
    expect(r.lift).toBeCloseTo(0, 3);
    expect(r.incrementalPaise).toBe(0);
    expect(r.liftCi[0]).toBeLessThan(0);
    expect(r.liftCi[1]).toBeGreaterThan(0);
  });

  it("gives a bootstrap interval that brackets the point estimate", () => {
    const r = estimate(synthetic({ treatedN: 1600, holdoutN: 400, treatedRate: 0.412, holdoutRate: 0.174 }));
    expect(r.incrementalCi[0]).toBeLessThan(r.incrementalPaise);
    expect(r.incrementalCi[1]).toBeGreaterThan(r.incrementalPaise);
  });

  it("is reproducible for a seed", () => {
    const data = synthetic({ treatedN: 300, holdoutN: 100, treatedRate: 0.4, holdoutRate: 0.2 });
    expect(estimate(data)).toEqual(estimate(data));
  });

  it("degrades safely with an empty holdout rather than dividing by zero", () => {
    const r = estimate(synthetic({ treatedN: 100, holdoutN: 0, treatedRate: 0.4, holdoutRate: 0 }));
    expect(r.holdoutRate).toBe(0);
    expect(Number.isFinite(r.incrementalPaise)).toBe(true);
    expect(r.incrementalCi).toEqual([0, 0]);
  });

  it("counts only cases the agent actually caused as true incremental", () => {
    const withLatent = [
      { ...outcome({ caseId: "a", recovered: true }), willPayRegardless: false },
      { ...outcome({ caseId: "b", recovered: true }), willPayRegardless: true },
      { ...outcome({ caseId: "c", recovered: false }), willPayRegardless: false },
      { ...outcome({ caseId: "d", holdout: true, recovered: true }), willPayRegardless: false },
    ];
    // Only "a": "b" would have paid anyway, "c" never paid, "d" is holdout.
    expect(trueIncremental(withLatent)).toBe(420_000);
  });

  it("lands the estimate near ground truth on a synthetic cohort", () => {
    // 2000 cases, 20% holdout. Natural recovery 18%; the agent converts a
    // further 24% of treated. The estimator sees only the arms.
    const rand = mulberry32(4242);
    const outcomes: (CaseOutcome & { willPayRegardless: boolean })[] = [];
    for (let i = 0; i < 2000; i++) {
      const holdout = i % 5 === 0;
      const willPayRegardless = rand() < 0.18;
      const causedByAgent = !holdout && !willPayRegardless && rand() < 0.29;
      outcomes.push({
        caseId: `c_${i}`, holdout,
        recovered: willPayRegardless || causedByAgent,
        amountPaise: 420_000,
        recoveredAfterMs: 86_400_000,
        willPayRegardless,
      });
    }
    const r = estimate(outcomes);
    const truth = trueIncremental(outcomes);

    expect(r.incrementalCi[0]).toBeLessThanOrEqual(truth);
    expect(r.incrementalCi[1]).toBeGreaterThanOrEqual(truth);
    const relError = Math.abs(r.incrementalPaise - truth) / truth;
    expect(relError).toBeLessThan(0.2);
  });
});
