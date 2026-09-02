import { randomUUID } from "node:crypto";
import {
  CapabilityMinter, VirtualClock, hashParams, loadConfig, loadPolicy,
  type EngineConfig, type Policy,
} from "@rra/core";
import { CaseEventStore, Ledger, getPool } from "@rra/db";
import { SimulatedPSP, type LatentCustomer } from "@rra/connectors";
import {
  Blackboard, CaseManager, Executor, ObligationLease, PolicyEngine, Reconciler,
  Scheduler, Tier0Resolver, TokenBurner, Verifier, WorkRouter,
} from "@rra/engine";
import {
  AgentRuntime, ConstrainedOptimizer, DeliberationReducer, valueActions,
  type LLMProvider,
} from "@rra/agents";
import { assignHoldout, estimate, stratumOf, trueIncremental, type CaseOutcome } from "@rra/attribution";
import type { Scenario } from "./scenario.js";
import { mulberry32 } from "@rra/attribution";
import { generateCohort, type SyntheticCase } from "./cohort.js";
import { World } from "./world.js";

export interface BatchOptions {
  scenario: Scenario;
  /** "full" runs the specialist fan-out; "tier0_only" is the ablation control. */
  arm?: "full" | "tier0_only";
  provider?: LLMProvider | null;
  policyPath?: string;
  signingKey?: Buffer;
  /** Virtual minutes per tick. */
  tickMinutes?: number;
  onProgress?: (pct: number) => void;
}

export interface BatchReport {
  batchId: string;
  arm: string;
  seed: number;
  cases: number;
  tier0Resolved: number;
  tier1Escalated: number;
  providerCalls: number;
  actionsExecuted: number;
  stepErrors: number;
  degradedEscalations: number;
  errorSamples: string[];
  policyBlocks: Record<string, number>;
  terminalStates: Record<string, number>;
  attribution: ReturnType<typeof estimate>;
  trueIncrementalPaise: number;
  /** |estimate - truth| / truth. The line no production team can show. */
  estimationError: number;
  intervalContainsTruth: boolean;
}

const HOUR = 3_600_000;

/**
 * The batch runner.
 *
 * Creates the cohort, runs it to terminal states under the virtual clock, and
 * emits the attribution report. This is the integration point for every phase:
 * case fabric, blackboard, Tier 0, agent runtime, policy, executor, verifier,
 * scheduler and attribution all run here exactly as they would in production.
 */
export async function runBatch(opts: BatchOptions): Promise<BatchReport> {
  const scenario = opts.scenario;
  const arm = opts.arm ?? "full";
  const batchId = `batch_${scenario.seed}_${arm}`;
  const config: EngineConfig = loadConfig();
  const policy: Policy = loadPolicy(opts.policyPath ?? `${process.cwd()}/policies/${scenario.merchant}.yaml`);

  const clock = new VirtualClock(new Date("2026-09-02T06:00:00Z"));
  const t0 = clock.now().getTime();

  const cohort = generateCohort(scenario, config.taxonomy);
  const world = new World(cohort, scenario.injections, scenario.seed);
  const latent = new Map<string, LatentCustomer>(
    cohort.map((c) => [
      c.customerId,
      {
        hasFundsAfterMs: t0 + c.latent.hasFundsAfterMs,
        cardExpired: c.latent.cardExpired,
        mandateState: c.latent.mandateState,
        respondsToLink: c.latent.respondsToLink,
        willPayRegardless: c.latent.willPayRegardless,
      },
    ]),
  );

  const psp = new SimulatedPSP(clock, latent, scenario.seed);
  const minter = new CapabilityMinter(opts.signingKey ?? Buffer.from("batch-signing-key"), clock);
  const burner = new TokenBurner(clock);
  const lease = new ObligationLease(clock);
  const blackboard = new Blackboard(clock);
  const scheduler = new Scheduler(clock);
  const cases = new CaseManager(clock);
  const ledger = new Ledger(clock);
  const events = new CaseEventStore(clock);
  const reconciler = new Reconciler(clock);
  const verifier = new Verifier(reconciler, ledger, clock);
  const policyEngine = new PolicyEngine(policy, config.library, minter, clock);
  const executor = new Executor(psp, config.library, minter, burner, lease, clock);
  const tier0 = new Tier0Resolver(config.taxonomy, config.playbooks);
  const router = new WorkRouter(blackboard);
  const runtime = new AgentRuntime(blackboard, config.library, config.taxonomy, clock, opts.provider ?? null);
  const reducer = new DeliberationReducer(opts.provider ?? null);
  const optimizer = new ConstrainedOptimizer(config.library);

  const byId = new Map(cohort.map((c) => [c.caseId, c]));
  const recoveredAt = new Map<string, number>();
  /**
   * Conversions do not settle instantly.
   *
   * A customer receives a link and pays hours later, so a converted action
   * queues a settlement rather than booking one immediately. Without this the
   * agent's recoveries land at t=0, inside the natural-recovery exclusion
   * window, and get stripped from the treated arm while the holdout's
   * spread-out natural payments are untouched — reintroducing exactly the
   * asymmetry the symmetric exclusion rule exists to prevent.
   */
  const pendingSettlements: { atMs: number; caseId: string; idemKey: string; amountPaise: number }[] = [];
  const settleRand = mulberry32(scenario.seed ^ 0xc0ffee);
  /** Remaining plan steps per case — a plan is a sequence, not one action. */
  const remainingSteps = new Map<string, { actionId: string; params: Record<string, unknown> }[]>();
  const attemptNos = new Map<string, number>();
  const stats = {
    tier0: 0, tier1: 0, providerCalls: 0, executed: 0, planned: 0,
    stepErrors: 0, degraded: 0, errorSamples: [] as string[],
  };

  await seedMerchant(scenario.merchant, cohort);

  // ---- Phase A: open every case and plan it -------------------------------
  for (const [i, sc] of cohort.entries()) {
    const holdout = assignHoldout(
      { caseId: sc.caseId, cause: sc.cause, amountPaise: sc.amountPaise },
      scenario.holdout,
      scenario.seed,
    );
    await cases.openOrAttach({
      caseId: sc.caseId, merchantId: scenario.merchant, customerId: sc.customerId,
      obligationId: sc.obligationId, externalRef: sc.externalRef, domain: sc.domain,
      amountPaise: sc.amountPaise, dueAt: clock.now(), holdout,
    });
    await getPool().query("UPDATE cases SET stratum = $2 WHERE id = $1", [
      sc.caseId,
      stratumOf({ caseId: sc.caseId, cause: sc.cause, amountPaise: sc.amountPaise }),
    ]);

    // The holdout arm is observed, never acted on. That is what it is for.
    if (holdout) continue;

    await plan(sc);
    if (i % 200 === 0) opts.onProgress?.(Math.round((i / cohort.length) * 50));
  }

  // ---- Phase B: run the clock forward -------------------------------------
  const tickMs = (opts.tickMinutes ?? 60) * 60_000;
  const horizonMs = scenario.windowDays * 86_400_000;

  for (let elapsed = 0; elapsed <= horizonMs; elapsed += tickMs) {
    clock.advanceTo(new Date(t0 + elapsed));

    // What the world does on its own — including in the holdout arm.
    for (const ev of world.drainUntil(elapsed)) {
      const sc = byId.get(ev.caseId);
      if (!sc || recoveredAt.has(ev.caseId)) continue;
      if (ev.kind === "natural_payment") {
        const out = await verifier.onSettlement({
          id: `set_nat_${ev.caseId}`, merchantId: scenario.merchant,
          amountPaise: sc.amountPaise, source: "natural", reference: sc.externalRef,
        });
        if (out.kind === "recovered") recoveredAt.set(ev.caseId, elapsed);
      } else {
        await verifier.onOutcome({
          caseId: ev.caseId,
          result: ev.kind === "opt_out" ? "opted_out" : "disputed",
        });
      }
    }

    // Conversions the agent caused, arriving after their latency.
    for (let i = pendingSettlements.length - 1; i >= 0; i--) {
      const p = pendingSettlements[i]!;
      if (p.atMs > elapsed) continue;
      pendingSettlements.splice(i, 1);
      if (recoveredAt.has(p.caseId)) continue;
      const settled = await verifier.onSettlement({
        id: `set_${p.idemKey.slice(0, 16)}`, merchantId: scenario.merchant,
        amountPaise: p.amountPaise, source: "connector", idemKey: p.idemKey,
      });
      if (settled.kind === "recovered") {
        recoveredAt.set(p.caseId, elapsed);
        remainingSteps.delete(p.caseId);
      }
    }

    // What the agent decided to do.
    for (const due of await scheduler.tick("batch_worker", 500)) {
      const sc = byId.get(due.caseId);
      if (!sc || recoveredAt.has(due.caseId)) {
        await scheduler.complete(due.id);
        continue;
      }
      await runStep(sc, due.actionRef.actionId, due.actionRef.params, due.actionRef.attemptNo, elapsed);
      await scheduler.complete(due.id);
    }

    opts.onProgress?.(50 + Math.round((elapsed / horizonMs) * 50));
  }

  // Cases that exhausted their plan without money arriving are unrecoverable,
  // not merely unfinished. Leaving them mid-state would misreport the batch.
  clock.advanceTo(new Date(t0 + horizonMs));
  for (const sc of cohort) {
    if (recoveredAt.has(sc.caseId)) continue;
    const { rows: st } = await getPool().query<{ state: string }>(
      "SELECT state FROM cases WHERE id = $1", [sc.caseId],
    );
    const state = st[0]?.state;
    if (state && !["RECOVERED", "OPTED_OUT", "DISPUTED", "UNRECOVERABLE", "STOPPED_HUMAN"].includes(state)) {
      await verifier.exhaust(sc.caseId, "measurement_window_closed");
    }
  }

  // ---- Phase C: measure ---------------------------------------------------
  const outcomes: (CaseOutcome & { willPayRegardless: boolean })[] = [];
  const { rows } = await getPool().query<{ id: string; holdout_flag: boolean; state: string }>(
    "SELECT id, holdout_flag, state FROM cases ORDER BY id",
  );
  const terminalStates: Record<string, number> = {};
  for (const row of rows) {
    const sc = byId.get(row.id)!;
    terminalStates[row.state] = (terminalStates[row.state] ?? 0) + 1;
    const at = recoveredAt.get(row.id);
    outcomes.push({
      caseId: row.id,
      holdout: row.holdout_flag,
      recovered: row.state === "RECOVERED",
      amountPaise: sc.amountPaise,
      ...(at !== undefined ? { recoveredAfterMs: at } : {}),
      willPayRegardless: sc.latent.willPayRegardless,
    });
  }

  const attribution = estimate(outcomes, {
    naturalRecoveryWindowMs: scenario.naturalRecoveryWindowMs,
    windowDays: scenario.windowDays,
    bootstrapSamples: 1000,
    seed: scenario.seed,
  });
  const truth = trueIncremental(outcomes);

  const report: BatchReport = {
    batchId, arm, seed: scenario.seed, cases: cohort.length,
    tier0Resolved: stats.tier0, tier1Escalated: stats.tier1,
    providerCalls: stats.providerCalls, actionsExecuted: stats.executed,
    stepErrors: stats.stepErrors, degradedEscalations: stats.degraded,
    errorSamples: stats.errorSamples,
    policyBlocks: await policyEngine.blockCountsByRule(),
    terminalStates,
    attribution,
    trueIncrementalPaise: truth,
    estimationError: truth === 0 ? 0 : Math.abs(attribution.incrementalPaise - truth) / truth,
    intervalContainsTruth:
      truth >= attribution.incrementalCi[0] && truth <= attribution.incrementalCi[1],
  };
  await persist(report);
  return report;

  // ---- helpers ------------------------------------------------------------

  /** Diagnose, plan, and schedule the first step. */
  async function plan(sc: SyntheticCase): Promise<void> {
    const evidenceId = `ev_${sc.caseId}`;
    await blackboard.addEvidence({
      id: evidenceId, caseId: sc.caseId, kind: "decline_code",
      payload: { rail: sc.rail, code: sc.code }, source: "simulator",
    });

    const outcome = tier0.resolve({ domain: sc.domain, rail: sc.rail, code: sc.code, attemptNo: 0 });
    if (outcome.resolved) {
      stats.tier0++;
      await ledger.append({
        caseId: sc.caseId, actor: "tier0", eventType: "plan_selected",
        payload: { ruleId: outcome.plan.ruleId, cause: outcome.classification.cause, tier: 0 },
      });
      await startPlan(sc, outcome.plan.steps.map((st) => ({ actionId: st.actionId, params: st.params })), 0);
      return;
    }

    // Tier 1: fan the specialists out, reduce, then optimize.
    stats.tier1++;
    if (arm === "tier0_only") {
      // The ablation control uses a generic per-rail default rather than
      // stopping — the degraded-mode rule is a safety property, and letting it
      // govern the control would credit deliberation with cases the control was
      // forbidden from attempting.
      const fallback = genericFallback(sc);
      if (fallback) {
        await startPlan(sc, [{ actionId: fallback, params: defaultParams(fallback, sc) }], 1);
      }
      return;
    }

    const revision = await currentRevision(sc.caseId);
    const permitted = (policy.allowedActions[sc.rail] ?? []) as string[];
    const decision = router.plan(["decline_code"], []);
    const run = await runtime.run(
      revision,
      decision.rerun,
      {
        caseId: sc.caseId, domain: sc.domain, rail: sc.rail, code: sc.code, attemptNo: 0,
        amountPaise: sc.amountPaise, evidenceRefs: [evidenceId], priorContacts: 0,
        optedOut: false, language: "en",
      },
      permitted,
    );
    stats.providerCalls += run.providerCalls;

    const diagnosis = run.claims.diagnosis;
    if (!diagnosis) {
      // Degraded mode. The architecture is explicit: fall back to Tier 0 only
      // where an explicit policy-allowed playbook exists, otherwise escalate or
      // stop safely. A provider outage must never manufacture a generic
      // recovery action, but it must not silently drop the case either.
      stats.degraded++;
      await ledger.append({
        caseId: sc.caseId, actor: "runtime", eventType: "degraded_escalation",
        payload: { degraded: true, reason: "no diagnosis claim available", tier: 2 },
      });
      const escalation = (policy.allowedActions[sc.rail] ?? []).includes("create_ops_escalation")
        ? "create_ops_escalation"
        : null;
      if (escalation) {
        await startPlan(sc, [{ actionId: escalation, params: defaultParams(escalation, sc) }], 2);
      }
      return;
    }
    const strategy = await reducer.reduce({
      diagnosis,
      context: run.claims.context ?? { intent: "unknown", optedOut: false, language: "en", priorContacts: 0 },
      incident: run.claims.incident ?? { attach: false, incidentId: null, suppress: false, rationale: "" },
    });
    if (strategy.suppress || strategy.stopReason) return;

    const economics = valueActions(
      { caseId: sc.caseId, domain: sc.domain, rail: sc.rail, code: sc.code, attemptNo: 0,
        amountPaise: sc.amountPaise, evidenceRefs: [evidenceId], priorContacts: 0,
        optedOut: false, language: "en" },
      config.library, strategy.selectedCause, permitted,
    );
    const ranked = optimizer.rank(economics.claim.candidates, {
      permitted, priorContacts: 0, modelSpendPaise: run.providerCalls * 2,
    });
    await ledger.append({
      caseId: sc.caseId, actor: "optimizer", eventType: "plan_optimized",
      payload: { selected: ranked.selected?.actionId ?? null, rejected: ranked.rejected, resolvedBy: strategy.resolvedBy },
    });
    if (!ranked.selected) return;

    await startPlan(
      sc,
      [{ actionId: ranked.selected.actionId, params: defaultParams(ranked.selected.actionId, sc) }],
      1,
    );
  }

  /**
   * Register a plan and schedule its first step.
   *
   * A plan is a sequence — "notify, wait 48h, retry within cap" — and running
   * only its first step is what made the first batch look like the agent did
   * almost nothing. Subsequent steps are scheduled as each one settles.
   */
  async function startPlan(
    sc: SyntheticCase,
    steps: { actionId: string; params: Record<string, unknown> }[],
    tier: number,
  ): Promise<void> {
    if (steps.length === 0) return;
    stats.planned++;
    remainingSteps.set(sc.caseId, [...steps]);
    attemptNos.set(sc.caseId, 0);
    await events.append(sc.caseId, { type: "diagnosis_started", tier: tier as 0 | 1 | 2 }, "runner");
    await events.append(sc.caseId, { type: "plan_proposed", planVersion: 1 }, "runner");
    await advancePlan(sc, 0);
  }

  /** Schedule the next step, honouring a `wait` step's delay. */
  async function advancePlan(sc: SyntheticCase, delayMs: number): Promise<void> {
    const steps = remainingSteps.get(sc.caseId);
    if (!steps || steps.length === 0) return;

    // Schedule actions carry the delay for what follows rather than executing.
    let extraDelay = delayMs;
    let next = steps.shift()!;
    while (config.library.get(next.actionId).kind === "schedule") {
      extraDelay += Number(next.params["delay_hours"] ?? next.params["expected_at_hours"] ?? 24) * HOUR;
      if (steps.length === 0) return;
      next = steps.shift()!;
    }

    const fireAt = new Date(clock.now().getTime() + extraDelay);
    await scheduler.schedule({
      caseId: sc.caseId,
      obligationId: sc.obligationId,
      fireAt,
      actionRef: {
        actionId: next.actionId,
        params: next.params,
        attemptNo: attemptNos.get(sc.caseId) ?? 0,
      },
    });
    await events.append(
      sc.caseId,
      { type: "action_scheduled", actionId: next.actionId, fireAt: fireAt.toISOString() },
      "runner",
    );
  }

  /** Authorize and execute one plan step. */
  async function runStep(
    sc: SyntheticCase, actionId: string, params: Record<string, unknown>,
    attemptNo: number, elapsed: number,
  ): Promise<void> {
    const action = config.library.get(actionId);
    if (action.kind === "schedule") return;

    const auth = await policyEngine.authorize({
      caseId: sc.caseId, obligationId: sc.obligationId, customerId: sc.customerId,
      rail: sc.rail, actionId, params, attemptNo,
      ...(action.amountCapped ? { amountPaise: sc.amountPaise } : {}),
    });
    // A blocked step ends the sequence: the rule that blocked it would block
    // the rest too, and continuing would just burn the retry cap.
    if (!auth.token) {
      remainingSteps.delete(sc.caseId);
      return;
    }

    // The policy allow *is* the approval, so record it: without this the case
    // jumps SCHEDULED -> OBSERVING, which the state machine rejects outright.
    await events.append(sc.caseId, { type: "approval_granted", approver: "policy_engine" }, "policy_engine");

    try {
      const out = await executor.execute({
        caseId: sc.caseId, obligationId: sc.obligationId, customerId: sc.customerId,
        actionId, attemptNo, params, token: auth.token,
        ...(action.amountCapped ? { amountPaise: sc.amountPaise } : {}),
      });
      stats.executed++;
      attemptNos.set(sc.caseId, attemptNo + 1);
      await events.append(sc.caseId, { type: "action_executed", actionId, attemptNo }, "executor");
      if (action.consumesContactBudget) {
        await policyEngine.consumeContactBudget(sc.customerId, String(params["channel"] ?? "sms"));
      }

      // A degraded segment swallows the attempt — this is the injection biting.
      const degraded = world.degradedAt(elapsed, sc);
      const paid = out.result.detail["paid"] === true && !degraded;
      if (paid) {
        // 2h to 3 days for the customer to act on it.
        const latency = Math.floor((2 + settleRand() * 70) * HOUR);
        pendingSettlements.push({
          atMs: elapsed + latency,
          caseId: sc.caseId,
          idemKey: out.idemKey,
          amountPaise: sc.amountPaise,
        });
      }
      // The plan continues either way. If the payment lands first, the terminal
      // write cancels the remaining steps — which is the behaviour worth showing.
      await advancePlan(sc, 0);
    } catch (err) {
      // A refused or failed step ends this case's sequence; the batch continues.
      // Counted and sampled rather than swallowed: a bare catch here hid an
      // illegal-transition bug for a whole run.
      stats.stepErrors++;
      if (stats.errorSamples.length < 5) stats.errorSamples.push((err as Error).message);
      remainingSteps.delete(sc.caseId);
    }
  }

  async function currentRevision(caseId: string) {
    const { rows } = await getPool().query<{ state_json: Record<string, unknown> }>(
      "SELECT state_json FROM case_revisions WHERE case_id = $1 ORDER BY revision DESC LIMIT 1",
      [caseId],
    );
    return rows[0]!.state_json as never;
  }

  function genericFallback(sc: SyntheticCase): string | null {
    const permitted = (policy.allowedActions[sc.rail] ?? []) as string[];
    for (const candidate of ["create_payment_link", "send_approved_template", "create_ops_escalation"]) {
      if (permitted.includes(candidate)) return candidate;
    }
    return null;
  }

  function defaultParams(actionId: string, sc: SyntheticCase): Record<string, unknown> {
    switch (actionId) {
      case "create_payment_link":
        return { amount: sc.amountPaise, currency: "INR", expiry_hours: 72 };
      case "send_approved_template":
        return { template_id: "WA_GENERIC_DUE", language: "en", slots: {}, channel: "whatsapp" };
      case "request_payment_method_update":
        return { reason_code: sc.cause.toUpperCase(), channel: "whatsapp" };
      case "resume_checkout":
        return { session_ref: sc.externalRef, preserve_cart: true };
      case "create_ops_escalation":
        return { queue: "collections", sla_hours: 24, summary_ref: sc.caseId };
      default:
        return {};
    }
  }

  async function persist(r: BatchReport): Promise<void> {
    await getPool().query(
      `INSERT INTO attribution_runs
         (id, batch_id, arm, treated_n, holdout_n, treated_recovered, holdout_recovered,
          treated_rate, holdout_rate, lift, lift_ci_low, lift_ci_high,
          gross_recovered_paise, incremental_paise, incremental_ci_low, incremental_ci_high,
          excluded_treated, excluded_holdout, window_days, provider_calls, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        randomUUID(), r.batchId, r.arm, r.attribution.treatedN, r.attribution.holdoutN,
        r.attribution.treatedRecovered, r.attribution.holdoutRecovered,
        r.attribution.treatedRate, r.attribution.holdoutRate, r.attribution.lift,
        r.attribution.liftCi[0], r.attribution.liftCi[1],
        r.attribution.grossRecoveredPaise, r.attribution.incrementalPaise,
        r.attribution.incrementalCi[0], r.attribution.incrementalCi[1],
        r.attribution.excludedTreated, r.attribution.excludedHoldout,
        scenario.windowDays, r.providerCalls, clock.now(),
      ],
    );
  }
}

async function seedMerchant(merchantId: string, cohort: readonly SyntheticCase[]): Promise<void> {
  await getPool().query(
    `INSERT INTO merchants (id, name, policy_version) VALUES ($1, $1, 'v7') ON CONFLICT (id) DO NOTHING`,
    [merchantId],
  );
  // One multi-row insert rather than 2000 round trips.
  const values = cohort.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(",");
  const params = cohort.flatMap((c) => [c.customerId, merchantId]);
  await getPool().query(
    `INSERT INTO customers (id, merchant_id) VALUES ${values} ON CONFLICT (id) DO NOTHING`,
    params,
  );
}
