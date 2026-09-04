import { bar, figure, head, hint, lede, measure, measures, page, pct, rupees, section, table } from "../render.js";
import { latestBatch, policyBlocks, terminalStates, tierCounts } from "../queries.js";

/** Overview — the money screen. */
export async function batchScreen(): Promise<string> {
  const b = await latestBatch();
  if (!b) {
    return page(
      "overview",
      "overview",
      head("No run yet", "Run <code>npm run batch scenarios/demo.yaml</code>, then reload."),
    );
  }

  const gross = Number(b.gross_recovered_paise);
  const incr = Number(b.incremental_paise);
  const [lo, hi] = [Number(b.incremental_ci_low), Number(b.incremental_ci_high)];

  // Incremental leads. Gross is set quiet beside it because the two are
  // routinely confused, and the whole point of the holdout is that they differ.
  const top = lede([
    figure(rupees(incr), "recovered by the agent", `95% interval ${rupees(lo)} – ${rupees(hi)}`),
    figure(rupees(gross), "collected in total", "includes money that would have arrived anyway", true),
  ]);

  const arms = table(
    ["arm", "cases", "recovered", "rate", ""],
    [
      ["treated", String(b.treated_n), String(b.treated_recovered), pct(b.treated_rate), bar(b.treated_rate)],
      ["holdout", String(b.holdout_n), String(b.holdout_recovered), pct(b.holdout_rate), bar(b.holdout_rate, true)],
    ],
    [1, 2, 3],
  );

  const tiers = await tierCounts();
  const tierTotal = tiers.reduce((s, x) => s + x.n, 0) || 1;
  const tierRows = tiers.map((t) => [
    `<span class="key">Tier ${t.tier}</span>`,
    t.tier === 0 ? "decline taxonomy and playbook" : t.tier === 1 ? "specialists deliberated" : "escalated to a person",
    String(t.n),
    bar(t.n / tierTotal, t.tier !== 0),
  ]);

  const terminals = await terminalStates();
  const totalCases = terminals.reduce((s, t) => s + t.n, 0) || 1;
  const termRows = terminals.map((t) => [
    `<span class="state state-${t.state}">${t.state.replace(/_/g, " ")}</span>`,
    String(t.n),
    rupees(Number(t.value)),
    bar(t.n / totalCases, t.state !== "RECOVERED"),
  ]);

  const blocks = (await policyBlocks()).filter((p) => p.outcome === "block");
  const blockRows = blocks.map((p) => [
    `<span class="mono">${p.rule_id}</span>`,
    p.reason,
    String(p.n),
  ]);

  return page(
    "overview",
    "overview",
    `${head(
      "Recovery run",
      `${b.treated_n + b.holdout_n} obligations at risk, worked over a ${b.window_days}-day window.`,
    )}
     ${top}
     ${measures([
       measure(pct(b.lift), "lift over holdout", `95% interval ${pct(b.lift_ci_low)} – ${pct(b.lift_ci_high)}`),
       measure(String(b.holdout_n), "held back", "never contacted, so the comparison is real"),
       measure(String(b.excluded_treated + b.excluded_holdout), "excluded as natural", "dropped from both arms alike"),
     ])}
     ${hint(
       `The holdout is the argument. Without a set of cases the agent never touched, any recovery
        number is just the money that happened to arrive.`,
     )}
     ${section("who decided", table(["", "how", "cases", ""], tierRows, [2]))}
     ${section("how cases ended", table(["outcome", "cases", "value", ""], termRows, [1, 2]))}
     ${blockRows.length ? section("actions the policy refused", table(["rule", "because", "count"], blockRows, [2])) : ""}`,
  );
}
