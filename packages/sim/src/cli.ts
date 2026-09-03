import { RealClock } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { CachedProvider, OpenAIResponsesProvider, type LLMProvider } from "@rra/agents";
import { loadScenario } from "./scenario.js";
import { runBatch } from "./runner.js";
import { renderAblation, renderReport } from "./report.js";

const path = process.argv[2] ?? "scenarios/demo.yaml";
const ablate = process.argv.includes("--ablate");

/**
 * Between ablation arms, everything except the attribution rows.
 *
 * The two arms reuse the same case ids, so the second would collide on the
 * first. But wiping attribution_runs too would throw away the comparison the
 * ablation exists to make.
 */
async function resetKeepingRuns(): Promise<void> {
  await getPool().query(
    `TRUNCATE incident_members, incidents, segment_windows, segment_baselines,
              promises_to_pay, checkout_sessions, settlements, action_attempts,
              token_burns, capability_tokens, policy_decisions, contact_budgets,
              claims, agent_runs, scheduled_actions, obligation_locks,
              case_revisions, case_events, evidence, ledger, cases, obligations,
              customers, merchants CASCADE`,
  );
}

async function reset(): Promise<void> {
  await getPool().query("TRUNCATE attribution_runs CASCADE");
  await resetKeepingRuns();
}

const scenario = loadScenario(path);

// The provider is optional. Without one the engine still runs end to end — Tier
// 0 handles ~95% of cases — but Tier 1 falls into degraded mode, and the
// ablation cannot measure anything.
// Cached by default so a rehearsal reproduces exactly and costs nothing.
// NO_CLAIM_CACHE=1 forces fresh calls.
const clock = new RealClock();
const provider: LLMProvider | null = process.env["OPENAI_API_KEY"]
  ? new CachedProvider(
      new OpenAIResponsesProvider(clock),
      clock,
      !process.env["NO_CLAIM_CACHE"],
    )
  : null;

console.log(`running ${scenario.size} cases, seed ${scenario.seed}, holdout ${scenario.holdout * 100}%`);
console.log(provider ? "provider: openai\n" : "provider: none — Tier 1 will run degraded\n");

await reset();

if (!ablate) {
  const full = await runBatch({ scenario, arm: "full", provider });
  console.log(renderReport(full));
} else {
  // Control first, full second. The full arm's cases are what the console and
  // the per-case ablation read afterwards, so it has to be the one left standing.
  const control = await runBatch({ scenario, arm: "tier0_only", provider: null });
  await resetKeepingRuns();
  const full = await runBatch({ scenario, arm: "full", provider });
  console.log(renderReport(full));
  console.log("\n" + renderAblation(full, control));
}

await closePool();
