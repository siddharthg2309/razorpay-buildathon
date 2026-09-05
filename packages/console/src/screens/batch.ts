import { bar, card, grid, page, pageHead, pct, rupees, section, stat, table } from "../render.js";
import { latestBatch, policyBlocks, terminalStates, tierCounts } from "../queries.js";
import { getPool } from "@rra/db";

/**
 * Overview — the screen that answers "did it work?" without being read.
 *
 * One figure leads: the money the agent caused. Everything under it exists to
 * make that figure believable — the arm it was measured against, who decided
 * each case, and what the policy refused. Total collected sits beside the
 * headline in a quieter weight, because it is the number people reach for by
 * mistake and the whole point of a holdout is that the two differ.
 */
export async function batchScreen(): Promise<string> {
  const b = await latestBatch();
  if (!b) {
    return page(
      "Overview",
      "/",
      pageHead("No run yet") + `<p class="note">Run <code>npm run batch scenarios/demo.yaml</code>, then reload.</p>`,
    );
  }

  const gross = Number(b.gross_recovered_paise);
  const incr = Number(b.incremental_paise);
  const lo = Number(b.incremental_ci_low);
  const hi = Number(b.incremental_ci_high);
  const total = b.treated_n + b.holdout_n;

  const headline = grid(4, [
    stat("Recovered by the agent", rupees(incr), "hero"),
    stat("95% interval", `${rupees(lo)} – ${rupees(hi)}`),
    stat("Collected in total", rupees(gross), "quiet"),
    stat("Lift over holdout", pct(b.lift)),
  ]);

  const arms = card(
    "Treated against held back",
    table(
      ["arm", "cases", "recovered", "rate", ""],
      [
        ["Treated", String(b.treated_n), String(b.treated_recovered), pct(b.treated_rate), bar(b.treated_rate)],
        ["Held back", String(b.holdout_n), String(b.holdout_recovered), pct(b.holdout_rate), bar(b.holdout_rate, true)],
      ],
      [1, 2, 3],
    ),
    b.excluded_treated + b.excluded_holdout ? `${b.excluded_treated + b.excluded_holdout} excluded` : "",
    true,
  );

  const tiers = await tierCounts();
  const tierTotal = tiers.reduce((s, x) => s + x.n, 0) || 1;
  const decided = card(
    "Who decided",
    table(
      ["", "how", "cases", ""],
      tiers.map((t) => [
        `<span class="chip">Tier ${t.tier}</span>`,
        t.tier === 0
          ? "Taxonomy and playbook"
          : t.tier === 1
            ? "Specialists"
            : "A person",
        String(t.n),
        bar(t.n / tierTotal, t.tier !== 0),
      ]),
      [2],
    ),
    "",
    true,
  );

  const terminals = await terminalStates();
  const totalCases = terminals.reduce((s, t) => s + t.n, 0) || 1;
  const outcomes = card(
    "How cases ended",
    table(
      ["outcome", "cases", "value", ""],
      terminals.map((t) => [
        `<span class="state state-${t.state}">${t.state.replace(/_/g, " ").toLowerCase()}</span>`,
        String(t.n),
        rupees(Number(t.value)),
        bar(t.n / totalCases, t.state !== "RECOVERED"),
      ]),
      [1, 2],
    ),
    "",
    true,
  );

  // Compliance is not a footnote here: refusing an action is the product
  // working, and the count is the only proof the rules are load-bearing.
  const blocks = (await policyBlocks()).filter((p) => p.outcome === "block");
  const refused = blocks.length
    ? card(
        "Actions the policy refused",
        table(
          ["rule", "because", "count"],
          blocks.map((p) => [`<span class="chip">${p.rule_id}</span>`, p.reason, String(p.n)]),
          [2],
        ),
        `${blocks.reduce((s, p) => s + p.n, 0)} refusals`,
        true,
      )
    : "";

  const { rows: inc } = await getPool().query<{ n: string; parked: string }>(
    `SELECT count(*) AS n,
            coalesce((SELECT count(*) FROM incident_members), 0) AS parked
       FROM incidents`,
  );
  const incidents = Number(inc[0]?.n ?? 0);

  const activity = grid(4, [
    stat("Obligations worked", String(total)),
    stat("Held back", String(b.holdout_n)),
    stat("Incidents", String(incidents)),
    stat("Provider calls", String(b.provider_calls)),
  ]);

  return page(
    "Overview",
    "/",
    `${pageHead("Recovery run")}
     ${headline}
     ${section("The measurement", `<div class="grid c2">${arms}${decided}</div>`)}
     ${section("Outcomes", `<div class="grid c2">${outcomes}${refused}</div>`)}
     ${section("Run at a glance", activity)}`,
    { footer: `Batch <span class="mono">${b.batch_id}</span><br>arm ${b.arm}` },
  );
}
