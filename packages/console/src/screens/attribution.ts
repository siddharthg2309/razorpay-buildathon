import { latestBatch } from "../queries.js";
import { bar, card, grid, page, pageHead, pct, rupees, section, stat, table } from "../render.js";

/** Attribution — the estimator, written out with this run's numbers in it. */
export async function attributionScreen(): Promise<string> {
  const b = await latestBatch();
  if (!b) return page("Attribution", "/attribution", pageHead("No run yet", "Run a batch first."));

  const lift = Number(b.lift);
  const incr = Number(b.incremental_paise);
  const meanValue = b.treated_n && lift !== 0 ? incr / (lift * b.treated_n) : 0;

  const equation = `<pre>  recovered by the agent

    =  ( treated rate   −   held-back rate )  ×  treated  ×  mean value

    =  (   ${pct(b.treated_rate)}      −      ${pct(b.holdout_rate)}     )  ×   ${b.treated_n}   ×  ${rupees(meanValue)}

    =  ${rupees(incr)}

       95% interval   ${rupees(Number(b.incremental_ci_low))}  –  ${rupees(Number(b.incremental_ci_high))}</pre>`;

  return page(
    "Attribution",
    "/attribution",
    `${pageHead("How the number is arrived at", "Measured against cases the agent never touched.")}
     ${grid(3, [
       stat("Recovered by the agent", rupees(incr), `interval ${rupees(Number(b.incremental_ci_low))} – ${rupees(Number(b.incremental_ci_high))}`, "hero"),
       stat("Collected in total", rupees(Number(b.gross_recovered_paise)), "before the counterfactual is removed", "quiet"),
       stat("Held back", String(b.holdout_n), "stratified, immutable once assigned"),
     ])}
     ${section("The estimator", card("", equation))}
     ${section("The two arms", card("", table(
       ["arm", "cases", "recovered", "rate", ""],
       [
         ["Treated", String(b.treated_n), String(b.treated_recovered), pct(b.treated_rate), bar(Number(b.treated_rate))],
         ["Held back", String(b.holdout_n), String(b.holdout_recovered), pct(b.holdout_rate), bar(Number(b.holdout_rate), true)],
       ],
       [1, 2, 3],
     ), "", true))}
     ${section("Reading the figure", `<div class="grid c2">
       ${b.excluded_treated + b.excluded_holdout
         ? card("Natural recovery", `<p class="note">Money that arrived on its own, dropped from
           <strong>both</strong> arms: ${b.excluded_treated} treated, ${b.excluded_holdout} held back.</p>`)
         : ""}
       ${card("Why it is a range", `<p class="note">Chance imbalance between the arms on what nobody
         can observe — who was going to pay regardless. Claim the interval, not the point.</p>`)}
     </div>`)}`,
  );
}
