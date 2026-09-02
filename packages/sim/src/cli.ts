import { RealClock } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { OpenAIResponsesProvider, type LLMProvider } from "@rra/agents";
import { loadScenario } from "./scenario.js";
import { runBatch } from "./runner.js";
import { renderAblation, renderReport } from "./report.js";

const path = process.argv[2] ?? "scenarios/demo.yaml";
const ablate = process.argv.includes("--ablate");

async function reset(): Promise<void> {
  await getPool().query(
    `TRUNCATE attribution_runs, incident_members, incidents, segment_windows, segment_baselines,
              settlements, action_attempts, token_burns, capability_tokens, policy_decisions,
              contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks,
              case_revisions, case_events, evidence, ledger, cases, obligations, customers,
              merchants CASCADE`,
  );
}

const scenario = loadScenario(path);

// The provider is optional. Without one the engine still runs end to end — Tier
// 0 handles ~95% of cases — but Tier 1 falls into degraded mode, and the
// ablation cannot measure anything.
const provider: LLMProvider | null = process.env["OPENAI_API_KEY"]
  ? new OpenAIResponsesProvider(new RealClock())
  : null;

console.log(`running ${scenario.size} cases, seed ${scenario.seed}, holdout ${scenario.holdout * 100}%`);
console.log(provider ? "provider: openai\n" : "provider: none — Tier 1 will run degraded\n");

await reset();
const full = await runBatch({ scenario, arm: "full", provider });
console.log(renderReport(full));

if (ablate) {
  await reset();
  const control = await runBatch({ scenario, arm: "tier0_only", provider: null });
  console.log("\n" + renderAblation(full, control));
}

await closePool();
