/**
 * Compares candidate estimators against the simulator's ground truth.
 *
 * Run offline over a completed batch: the cohort is deterministic, so the
 * latent willPayRegardless flag can be regenerated and used as the answer key.
 * Nothing here ships — it exists to decide which estimator the product should
 * use, on evidence rather than intuition.
 */
import { loadConfig } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { generateCohort, loadScenario } from "@rra/sim";
import { valueBand, type CaseOutcome } from "@rra/attribution";

const scenario = loadScenario("scenarios/demo.yaml");
const cohort = generateCohort(scenario, loadConfig().taxonomy);
const latent = new Map(cohort.map((c) => [c.caseId, c]));

const { rows } = await getPool().query<{
  id: string; holdout_flag: boolean; state: string; cause: string | null; amount_paise: string;
}>(
  `SELECT c.id, c.holdout_flag, c.state, c.cause, o.amount_paise
     FROM cases c JOIN obligations o ON o.id = c.obligation_id WHERE c.id LIKE 'c_%'`,
);

interface Row extends CaseOutcome { cause: string; band: string; wpr: boolean }
const data: Row[] = rows.flatMap((r) => {
  const sc = latent.get(r.id);
  if (!sc) return [];
  return [{
    caseId: r.id,
    holdout: r.holdout_flag,
    recovered: r.state === "RECOVERED",
    amountPaise: Number(r.amount_paise),
    cause: r.cause ?? sc.cause,
    band: valueBand(Number(r.amount_paise)),
    wpr: sc.latent.willPayRegardless,
  }];
});

const truth = data
  .filter((d) => !d.holdout && d.recovered && !d.wpr)
  .reduce((s, d) => s + d.amountPaise, 0);

const treated = data.filter((d) => !d.holdout);
const holdout = data.filter((d) => d.holdout);
const rate = (xs: Row[]) => (xs.length ? xs.filter((x) => x.recovered).length / xs.length : 0);
const meanValue = (xs: Row[]) => (xs.length ? xs.reduce((s, x) => s + x.amountPaise, 0) / xs.length : 0);

/** The shipped estimator: one pooled lift times population mean value. */
const pooled = (rate(treated) - rate(holdout)) * treated.length * meanValue(treated);

/** Post-stratify on a pre-treatment covariate, then sum the strata. */
function stratified(key: (r: Row) => string, minHoldout: number): number {
  const keys = [...new Set(data.map(key))];
  const pooledLift = rate(treated) - rate(holdout);
  let total = 0;
  for (const k of keys) {
    const t = treated.filter((r) => key(r) === k);
    const h = holdout.filter((r) => key(r) === k);
    if (t.length === 0) continue;
    // A thin stratum's own lift is noise; borrow the pooled one.
    const lift = h.length >= minHoldout ? rate(t) - rate(h) : pooledLift;
    total += lift * t.length * meanValue(t);
  }
  return total;
}

const candidates: [string, number][] = [
  ["pooled (shipped)", pooled],
  ["stratified by cause", stratified((r) => r.cause, 20)],
  ["stratified by value band", stratified((r) => r.band, 20)],
  ["stratified by cause x band", stratified((r) => `${r.cause}|${r.band}`, 20)],
];

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
console.log(`ground truth   ${rupees(truth)}`);
console.log(`treated ${treated.length}  holdout ${holdout.length}\n`);
console.log("estimator                      estimate        error");
for (const [name, est] of candidates) {
  const err = Math.abs(est - truth) / truth;
  console.log(`  ${name.padEnd(28)} ${rupees(est).padStart(12)}   ${(err * 100).toFixed(1)}%`);
}

// Is the arms' imbalance on the unobservable covariate the dominant term?
const wprTreated = treated.filter((d) => d.wpr).length / treated.length;
const wprHoldout = holdout.filter((d) => d.wpr).length / holdout.length;
console.log(`\nwould-pay-anyway share: treated ${(wprTreated * 100).toFixed(1)}%  holdout ${(wprHoldout * 100).toFixed(1)}%`);
console.log(`imbalance costs roughly ${rupees((wprTreated - wprHoldout) * treated.length * meanValue(treated))}`);
await closePool();
