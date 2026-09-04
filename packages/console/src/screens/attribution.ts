import { latestBatch } from "../queries.js";
import { bar, figure, head, hint, lede, measure, measures, page, pct, rupees, section, table } from "../render.js";

/** Attribution — the estimator, written out with this run's numbers. */
export async function attributionScreen(): Promise<string> {
  const b = await latestBatch();
  if (!b) return page("attribution", "attribution", head("No run yet", "Run a batch first."));

  const lift = Number(b.lift);
  const incr = Number(b.incremental_paise);
  const meanValue = b.treated_n && lift !== 0 ? incr / (lift * b.treated_n) : 0;

  const equation = `<pre>  recovered by the agent
      =  ( treated rate  −  holdout rate )  ×  treated  ×  mean value

      =  ( ${pct(b.treated_rate)}  −  ${pct(b.holdout_rate)} )  ×  ${b.treated_n}  ×  ${rupees(meanValue)}

      =  ${rupees(incr)}        95% interval  ${rupees(Number(b.incremental_ci_low))} – ${rupees(Number(b.incremental_ci_high))}</pre>`;

  const arms = table(
    ["arm", "cases", "recovered", "rate", ""],
    [
      ["treated", String(b.treated_n), String(b.treated_recovered), pct(b.treated_rate), bar(Number(b.treated_rate))],
      ["held back", String(b.holdout_n), String(b.holdout_recovered), pct(b.holdout_rate), bar(Number(b.holdout_rate), true)],
    ],
    [1, 2, 3],
  );

  return page(
    "attribution",
    "attribution",
    `${head("How the number is arrived at", "Nothing here is a proxy for money. The figure is what the agent caused, measured against cases it never touched.")}
     ${lede([
       figure(rupees(incr), "recovered by the agent"),
       figure(rupees(Number(b.gross_recovered_paise)), "collected in total", "", true),
     ])}
     ${section("the estimator", equation)}
     ${section("the two arms", arms)}
     ${section("what is excluded", `
       <p class="note">Money that arrived on its own is dropped from <em>both</em> arms:
       ${b.excluded_treated} treated, ${b.excluded_holdout} held back. Excluding it from the
       treated arm alone would look rigorous and quietly inflate the result, because the held-back
       arm has no contact to measure against.</p>`)}
     ${section("what the interval is for", `
       <p class="note">The interval is set by the held-back arm, which is the small one. What is
       left over is chance imbalance between the two groups on things nobody can observe — who was
       going to pay anyway. No amount of reweighting fixes that, which is why the figure is
       reported as a range rather than a point.</p>`)}
     ${hint("Claim the interval, not the point.")}`,
  );
}
