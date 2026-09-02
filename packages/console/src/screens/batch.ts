import { bar, kpi, page, panel, pct, rupees, table } from "../render.js";
import { latestBatch, policyBlocks, terminalStates, tierCounts } from "../queries.js";

/** Screen 1 — the money screen. */
export async function batchScreen(): Promise<string> {
  const b = await latestBatch();
  if (!b) {
    return page("batch", "batch", panel("no run yet", `<p class="note">Run <code>npm run batch scenarios/demo.yaml</code>, then reload.</p>`));
  }

  const gross = Number(b.gross_recovered_paise);
  const incr = Number(b.incremental_paise);
  const [lo, hi] = [Number(b.incremental_ci_low), Number(b.incremental_ci_high)];

  const head = `<div class="kpis">
    ${kpi(rupees(gross), "gross recovered", "money that arrived")}
    ${kpi(rupees(incr), "est. incremental", `95% CI ${rupees(lo)} – ${rupees(hi)}`, true)}
    ${kpi(pct(b.lift), "recovery lift", `95% CI ${pct(b.lift_ci_low)} – ${pct(b.lift_ci_high)}`)}
    ${kpi(String(b.treated_n + b.holdout_n), "cases", `${b.window_days}-day window`)}
  </div>`;

  const arms = table(
    ["arm", "n", "recovered", "rate", ""],
    [
      ["treated", String(b.treated_n), String(b.treated_recovered), pct(b.treated_rate), bar(b.treated_rate)],
      ["holdout", String(b.holdout_n), String(b.holdout_recovered), pct(b.holdout_rate), bar(b.holdout_rate, true)],
    ],
    [1, 2, 3],
  );

  const tiers = await tierCounts();
  const tierRows = tiers.map((t) => [
    `<span class="tag t${t.tier}">TIER ${t.tier}</span>`,
    String(t.n),
    bar(t.n / tiers.reduce((s, x) => s + x.n, 0)),
  ]);

  const terminals = await terminalStates();
  const totalCases = terminals.reduce((s, t) => s + t.n, 0);
  const termRows = terminals.map((t) => [
    `<span class="state-${t.state}">${t.state}</span>`,
    String(t.n),
    rupees(Number(t.value)),
    bar(t.n / totalCases, t.state !== "RECOVERED"),
  ]);

  const blocks = (await policyBlocks()).filter((p) => p.outcome === "block");
  const blockRows = blocks.map((p) => [
    `<span class="tag blocked">${p.rule_id}</span>`,
    String(p.n),
    `<span class="note">${p.reason}</span>`,
  ]);

  return page(
    "batch",
    "batch",
    `<h1>Batch run · ${b.batch_id} · arm ${b.arm}</h1>
     ${head}
     <div class="panel" style="margin-top:16px">
       <div class="hd">gross is not incremental</div>
       <p class="note">Gross is every rupee that arrived. Incremental is the money the agent
       <em>caused</em>, measured against a randomised holdout that was never acted on.
       Excluded as natural recovery, symmetrically from both arms:
       ${b.excluded_treated} treated, ${b.excluded_holdout} holdout.</p>
     </div>
     ${panel("arms", arms)}
     ${panel("decision ladder", table(["tier", "cases", ""], tierRows, [1]))}
     ${panel("terminal states", table(["state", "cases", "value at risk", ""], termRows, [1, 2]))}
     ${blockRows.length ? panel("policy blocks", table(["rule", "blocked", "reason"], blockRows, [1])) : ""}`,
  );
}
