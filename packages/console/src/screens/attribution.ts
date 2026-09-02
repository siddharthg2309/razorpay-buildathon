import { latestBatch } from "../queries.js";
import { bar, kpi, page, panel, pct, rupees, table } from "../render.js";

/** Screen 5 — attribution. The estimator written out with the actual numbers. */
export async function attributionScreen(): Promise<string> {
  const b = await latestBatch();
  if (!b) return page("attribution", "attribution", panel("no run yet", `<p class="note">Run a batch first.</p>`));

  const lift = Number(b.lift);
  const treatedN = b.treated_n;
  const incr = Number(b.incremental_paise);
  const meanValue = treatedN && lift !== 0 ? incr / (lift * treatedN) : 0;

  const equation = `
<pre>  incremental = ( rate_treated − rate_holdout ) × treated_volume × mean_value_at_risk

              = ( ${pct(b.treated_rate)} − ${pct(b.holdout_rate)} ) × ${treatedN} × ${rupees(meanValue)}

              = ${rupees(incr)}          95% CI ${rupees(Number(b.incremental_ci_low))} – ${rupees(Number(b.incremental_ci_high))}</pre>`;

  const arms = table(
    ["arm", "n", "recovered", "rate", ""],
    [
      ["treated", String(b.treated_n), String(b.treated_recovered), pct(b.treated_rate), bar(Number(b.treated_rate))],
      ["holdout", String(b.holdout_n), String(b.holdout_recovered), pct(b.holdout_rate), bar(Number(b.holdout_rate), true)],
    ],
    [1, 2, 3],
  );

  return page(
    "attribution",
    "attribution",
    `<h1>Attribution</h1>
     <div class="kpis">
       ${kpi(rupees(Number(b.gross_recovered_paise)), "gross", "money that arrived")}
       ${kpi(rupees(incr), "incremental", "money the agent caused", true)}
       ${kpi(pct(lift), "lift", `95% CI ${pct(b.lift_ci_low)} – ${pct(b.lift_ci_high)}`)}
       ${kpi(String(b.holdout_n), "holdout", "never acted on")}
     </div>
     ${panel("the estimator, with this run's numbers substituted", equation)}
     ${panel("arms", arms)}
     ${panel("exclusions — applied symmetrically to both arms", `
       <p class="note">Recoveries landing inside the natural-recovery window are dropped from
       <em>both</em> arms: ${b.excluded_treated} treated, ${b.excluded_holdout} holdout. A
       contact-relative rule would subtract them from treated only — the holdout has no contact —
       and bias the estimate upward.</p>`)}
     ${panel("what the interval is for", `
       <p class="note">The interval is driven by the holdout arm, which is the small one. Residual
       error against the simulator's ground truth is dominated by chance imbalance between the arms
       on covariates nobody can observe — in this world, the share of customers who would have paid
       anyway. Nothing observable corrects that, which is exactly why the number is reported with an
       interval rather than as a point.</p>`)}`,
  );
}
