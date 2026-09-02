/** Compares each arm against the simulator's latent truth. */
import { loadConfig } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { generateCohort, loadScenario } from "@rra/sim";
import { assignHoldout } from "@rra/attribution";

const scenario = loadScenario("scenarios/demo.yaml");
const cohort = generateCohort(scenario, loadConfig().taxonomy);
const { rows } = await getPool().query<{ id: string; state: string; holdout_flag: boolean }>(
  "SELECT id, state, holdout_flag FROM cases",
);
const state = new Map(rows.map((r) => [r.id, r]));

const cell = (holdout: boolean, wpr: boolean) => {
  const group = cohort.filter((c) => {
    const s = state.get(c.caseId);
    return s && s.holdout_flag === holdout && c.latent.willPayRegardless === wpr;
  });
  const rec = group.filter((c) => state.get(c.caseId)!.state === "RECOVERED");
  return {
    n: group.length,
    recovered: rec.length,
    rate: group.length ? rec.length / group.length : 0,
    valuePaise: rec.reduce((s, c) => s + c.amountPaise, 0),
  };
};

for (const [label, holdout] of [["TREATED", false], ["HOLDOUT", true]] as const) {
  const wpr = cell(holdout, true);
  const not = cell(holdout, false);
  console.log(`${label}`);
  console.log(`  willPayRegardless   n=${wpr.n}  recovered=${wpr.recovered}  rate=${(wpr.rate * 100).toFixed(1)}%`);
  console.log(`  would NOT pay       n=${not.n}  recovered=${not.recovered}  rate=${(not.rate * 100).toFixed(1)}%`);
  console.log(`  overall rate        ${(((wpr.recovered + not.recovered) / (wpr.n + not.n)) * 100).toFixed(1)}%`);
}
await closePool();
