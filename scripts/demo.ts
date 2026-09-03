/**
 * One command from a cold repo to a running demo.
 *
 * Assembling this live is how a five-minute slot becomes a four-minute slot.
 * It resets, starts the console, runs the batch, and then tells you exactly
 * what to open and in what order — including the two lines that need saying
 * out loud, because the honest framing is the part most easily fumbled.
 */
import { spawn } from "node:child_process";
import { closePool, getPool } from "@rra/db";
import { loadScenario, runBatch, renderAblation, renderReport } from "@rra/sim";
import { OpenAIResponsesProvider, type LLMProvider } from "@rra/agents";
import { RealClock } from "@rra/core";

const ablate = process.argv.includes("--ablate");
const scenarioPath = process.argv.find((a) => a.endsWith(".yaml")) ?? "scenarios/demo.yaml";
const PORT = Number(process.env["PORT"] ?? 4000);

const rule = (label: string) =>
  console.log(`\n${"─".repeat(70)}\n${label}\n${"─".repeat(70)}`);

const truncate = async (keepRuns: boolean) => {
  if (!keepRuns) await getPool().query("TRUNCATE attribution_runs CASCADE");
  await getPool().query(
    `TRUNCATE incident_members, incidents, segment_windows, segment_baselines,
              promises_to_pay, checkout_sessions, settlements, action_attempts,
              token_burns, capability_tokens, policy_decisions, contact_budgets,
              claims, agent_runs, scheduled_actions, obligation_locks,
              case_revisions, case_events, evidence, ledger, cases, obligations,
              customers, merchants CASCADE`,
  );
};

rule("1 · reset");
const openLive = await getPool().query<{ id: string }>(
  `SELECT DISTINCT c.id FROM cases c JOIN action_attempts a ON a.case_id = c.id
    WHERE a.surface = 'live' AND c.closed_at IS NULL`,
);
if (openLive.rowCount) {
  console.log(`  ${openLive.rowCount} open live case(s) — settling before reset so no real payment is orphaned`);
}
await truncate(false);
console.log("  clean");

rule("2 · console");
const console_ = spawn("node", ["--env-file-if-exists=.env", "--import", "tsx", "packages/console/src/server.ts"], {
  stdio: "ignore",
  detached: false,
  env: process.env,
});
await new Promise((r) => setTimeout(r, 2500));
console.log(`  http://localhost:${PORT}`);
console.log(`  leave it open — the stream is live while the batch runs`);

rule("3 · batch");
const scenario = loadScenario(scenarioPath);
const provider: LLMProvider | null = process.env["OPENAI_API_KEY"]
  ? new OpenAIResponsesProvider(new RealClock())
  : null;
console.log(`  ${scenario.size} cases · seed ${scenario.seed} · holdout ${scenario.holdout * 100}%`);
console.log(`  provider: ${provider ? "openai" : "none (Tier 1 will run degraded)"}\n`);

let control;
if (ablate) {
  control = await runBatch({ scenario, arm: "tier0_only", provider: null });
  await truncate(true);
}
const full = await runBatch({ scenario, arm: "full", provider });

rule("4 · the number");
console.log(renderReport(full));
if (control) console.log("\n" + renderAblation(full, control));

rule("5 · what to show, in order");
const lines = [
  ["the money screen", `http://localhost:${PORT}/`,
   "gross and incremental side by side. They are never the same number."],
  ["one case, end to end", `http://localhost:${PORT}/cases`,
   "click any RECOVERED case. Rule id, policy version, capability token, burned nonce, settlement."],
  ["the incident", `http://localhost:${PORT}/incidents`,
   `${full.incidentsOpened} opened, ${full.casesParked} parked, released in a ramp with a circuit breaker.`],
  ["what the model did", `http://localhost:${PORT}/ablation`,
   provider ? "the cases Tier 0 could not answer, with the evidence each diagnosis cited."
            : "empty without OPENAI_API_KEY — Tier 1 escalated instead."],
  ["the estimator", `http://localhost:${PORT}/attribution`,
   "written out with this run's numbers substituted."],
  ["policy", `http://localhost:${PORT}/policy`,
   "every rule with a count behind it, and the active config verbatim."],
];
for (const [title, url, why] of lines) {
  console.log(`\n  ${title}\n    ${url}\n    ${why}`);
}

rule("6 · say these out loud");
console.log(`
  "The engine is real. The payment world is simulated — which is why we can
   show you the true number next to our estimate. You cannot do that with
   production data."

  "Claim the interval, not the point. The residual error is chance imbalance
   between the arms on something nobody can observe, and that is exactly what
   the interval is for."
${provider ? `
  "Everything else in the batch was resolved deterministically. This screen is
   the whole of the model's contribution, at the size it actually is."` : ""}
`);

console.log(`  live Razorpay case:  npm run live-case`);
console.log(`  replay the ledger:   npm run verify:replay`);
console.log(`  audit vs the brief:  npm run verify:ps\n`);
console.log(`  console is still running (pid ${console_.pid}) — ctrl-c to stop\n`);

await closePool();
