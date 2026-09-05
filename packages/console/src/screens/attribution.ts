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
    `${pageHead("How the number is arrived at")}
     ${grid(4, [
       stat("Recovered by the agent", rupees(incr), "hero"),
       stat("95% interval", `${rupees(Number(b.incremental_ci_low))} – ${rupees(Number(b.incremental_ci_high))}`),
       stat("Collected in total", rupees(Number(b.gross_recovered_paise)), "quiet"),
       stat("Held back", String(b.holdout_n)),
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
     ${b.excluded_treated + b.excluded_holdout
       ? section("Excluded as natural recovery", card("", table(
           ["arm", "cases dropped"],
           [["Treated", String(b.excluded_treated)], ["Held back", String(b.excluded_holdout)]],
           [1],
         ), "", true))
       : ""}`,
  );
}
