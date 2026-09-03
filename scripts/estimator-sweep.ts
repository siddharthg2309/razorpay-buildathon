/**
 * The same estimator comparison, across many seeds.
 *
 * One seed cannot choose an estimator: whichever happens to sit nearest the
 * truth on a single draw will look best, and adopting it is fitting to noise.
 * This runs independent worlds and reports mean absolute error and bias, which
 * is what actually distinguishes them.
 */
import { loadConfig } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { generateCohort, loadScenario, runBatch } from "@rra/sim";
import { valueBand } from "@rra/attribution";

const seeds = [20260902, 11, 273, 4242, 8675309, 99991, 5150, 31337];
const size = Number(process.env["SWEEP_SIZE"] ?? 1200);
const base = loadScenario("scenarios/demo.yaml");
const taxonomy = loadConfig().taxonomy;

interface Row { holdout: boolean; recovered: boolean; amountPaise: number; cause: string; band: string; wpr: boolean }

const truncate = () =>
  getPool().query(
    `TRUNCATE attribution_runs, incident_members, incidents, segment_windows, segment_baselines,
              promises_to_pay, checkout_sessions, settlements, action_attempts, token_burns,
              capability_tokens, policy_decisions, contact_budgets, claims, agent_runs,
              scheduled_actions, obligation_locks, case_revisions, case_events, evidence,
              ledger, cases, obligations, customers, merchants CASCADE`,
  );

const rate = (xs: Row[]) => (xs.length ? xs.filter((x) => x.recovered).length / xs.length : 0);
const meanValue = (xs: Row[]) => (xs.length ? xs.reduce((s, x) => s + x.amountPaise, 0) / xs.length : 0);

function stratified(data: Row[], key: (r: Row) => string, minHoldout: number): number {
  const treated = data.filter((d) => !d.holdout);
  const holdout = data.filter((d) => d.holdout);
  const pooledLift = rate(treated) - rate(holdout);
  let total = 0;
  for (const k of new Set(data.map(key))) {
    const t = treated.filter((r) => key(r) === k);
    const h = holdout.filter((r) => key(r) === k);
    if (t.length === 0) continue;
    const lift = h.length >= minHoldout ? rate(t) - rate(h) : pooledLift;
    total += lift * t.length * meanValue(t);
  }
  return total;
}

const NAMES = ["pooled", "by cause", "by band", "by cause x band"] as const;
const errors: Record<string, number[]> = Object.fromEntries(NAMES.map((n) => [n, []]));
const signed: Record<string, number[]> = Object.fromEntries(NAMES.map((n) => [n, []]));

for (const seed of seeds) {
  const scenario = { ...base, seed, size };
  await truncate();
  await runBatch({ scenario, arm: "full", provider: null });

  const latent = new Map(generateCohort(scenario, taxonomy).map((c) => [c.caseId, c]));
  const { rows } = await getPool().query<{
    id: string; holdout_flag: boolean; state: string; cause: string | null; amount_paise: string;
  }>(`SELECT c.id, c.holdout_flag, c.state, c.cause, o.amount_paise
        FROM cases c JOIN obligations o ON o.id = c.obligation_id WHERE c.id LIKE 'c_%'`);

  const data: Row[] = rows.flatMap((r) => {
    const sc = latent.get(r.id);
    if (!sc) return [];
    return [{
      holdout: r.holdout_flag,
      recovered: r.state === "RECOVERED",
      amountPaise: Number(r.amount_paise),
      cause: r.cause ?? sc.cause,
      band: valueBand(Number(r.amount_paise)),
      wpr: sc.latent.willPayRegardless,
    }];
  });

  const truth = data.filter((d) => !d.holdout && d.recovered && !d.wpr)
    .reduce((s, d) => s + d.amountPaise, 0);
  if (truth === 0) continue;

  const treated = data.filter((d) => !d.holdout);
  const holdout = data.filter((d) => d.holdout);
  const estimates: Record<string, number> = {
    pooled: (rate(treated) - rate(holdout)) * treated.length * meanValue(treated),
    "by cause": stratified(data, (r) => r.cause, 20),
    "by band": stratified(data, (r) => r.band, 20),
    "by cause x band": stratified(data, (r) => `${r.cause}|${r.band}`, 20),
  };
  for (const n of NAMES) {
    errors[n]!.push(Math.abs(estimates[n]! - truth) / truth);
    signed[n]!.push((estimates[n]! - truth) / truth);
  }
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`seed ${String(seed).padEnd(9)} ` +
    NAMES.map((n) => `${n} ${pct(Math.abs(estimates[n]! - truth) / truth).padStart(6)}`).join("  "));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`\nacross ${errors["pooled"]!.length} seeds, ${size} cases each\n`);
console.log("estimator            mean abs error    mean signed (bias)");
for (const n of NAMES) {
  console.log(`  ${n.padEnd(18)} ${(mean(errors[n]!) * 100).toFixed(1).padStart(8)}%      ${(mean(signed[n]!) * 100).toFixed(1).padStart(7)}%`);
}
await closePool();
