import { getPool } from "@rra/db";
import { bar, card, esc, grid, page, pageHead, pct, rupees, section, stat, table } from "../render.js";

interface Arm {
  arm: string; incremental_paise: string; lift: number;
  treated_n: number; provider_calls: number;
}

/**
 * What the model contributed.
 *
 * Leads with the size of the difference the batch can actually resolve, not
 * with the difference itself. When the arms diverge on a few percent of cases,
 * a rupee figure reads as precision it does not have.
 */
export async function ablationScreen(): Promise<string> {
  const { rows: arms } = await getPool().query<Arm>(
    `SELECT DISTINCT ON (arm) arm, incremental_paise, lift, treated_n, provider_calls
       FROM attribution_runs ORDER BY arm, created_at DESC`,
  );
  const full = arms.find((a) => a.arm === "full");
  const control = arms.find((a) => a.arm === "tier0_only");

  const { rows: decisions } = await getPool().query<{
    case_id: string; role: string; confidence: number | null;
    payload: Record<string, unknown>; model: string | null; latency_ms: number | null;
    state: string; rail: string | null; amount_paise: string; evidence_refs: string[];
  }>(
    `SELECT c.id AS case_id, cl.role, cl.confidence, cl.payload, cl.evidence_refs,
            r.model, r.latency_ms, c.state, c.rail, o.amount_paise
       FROM claims cl
       JOIN cases c ON c.id = cl.case_id
       JOIN obligations o ON o.id = c.obligation_id
       JOIN agent_runs r ON r.id = cl.agent_run_id
      WHERE r.provider IS NOT NULL
      ORDER BY o.amount_paise DESC`,
  );

  if (decisions.length === 0 && !full) {
    return page("Model", "/ablation",
      `${pageHead("The model has not run")}
       <p class="note">Tier 0 resolved every case from the decline taxonomy. Set a key in
       <code>.env</code> and run the batch again.</p>`);
  }

  const recovered = decisions.filter((d) => d.state === "RECOVERED").length;
  const spread = new Map<string, number>();
  for (const d of decisions) {
    const c = String(d.payload["primaryCause"] ?? "—");
    spread.set(c, (spread.get(c) ?? 0) + 1);
  }

  let verdict = "";
  if (full && control) {
    const delta = Number(full.incremental_paise) - Number(control.incremental_paise);
    const differing = decisions.length || full.treated_n;
    const meanValue = decisions.length
      ? decisions.reduce((s, d) => s + Number(d.amount_paise), 0) / decisions.length
      : 0;
    const band = Math.round(1.96 * Math.sqrt(differing) * meanValue * 0.5);
    const readable = Math.abs(delta) > band;

    verdict = `
      ${grid(3, [
        stat("Difference it made", rupees(delta), "hero"),
        stat("What the batch can resolve", `± ${rupees(band)}`, "quiet"),
        stat("Cases it decided", String(differing)),
      ])}
      ${section("With the model, and without it", card("", table(
        ["arm", "recovered by the agent", "lift", "provider calls"],
        [
          ["With the model", rupees(Number(full.incremental_paise)), pct(full.lift), String(full.provider_calls)],
          ["Playbooks only", rupees(Number(control.incremental_paise)), pct(control.lift), "0"],
        ],
        [1, 2, 3],
      ), "", true))}
      ${section(readable ? "Large enough to read" : "Too small to read",
        readable
          ? `<p class="note">Larger than the noise a batch this size carries. It compares the model
             against a generic playbook, not against hand-written rules over the same evidence.</p>`
          : `<p class="note">The arms differ on ${differing} cases — too few for a batch total to
             resolve. The claim worth making is the one below, case by case.</p>`)}`;
  }

  const rows = decisions.slice(0, 40).map((d) => [
    `<a href="/case/${esc(d.case_id)}" class="mono">${esc(d.case_id)}</a>`,
    rupees(Number(d.amount_paise)),
    esc(d.rail ?? "—"),
    esc(String(d.payload["primaryCause"] ?? d.payload["intent"] ?? "—").replace(/_/g, " ")),
    d.confidence !== null ? d.confidence.toFixed(2) : "—",
    `<span class="mono">${esc(d.evidence_refs?.join(", ") ?? "")}</span>`,
    `<span class="state state-${esc(d.state)}">${esc(d.state.replace(/_/g, " "))}</span>`,
  ]);

  return page(
    "Model",
    "/ablation",
    `${pageHead("What the model decided")}
     ${verdict}
     ${section("What it concluded", card("",
       table(["cause", "cases", ""],
         [...spread.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) =>
           [esc(c.replace(/_/g, " ")), String(n), bar(n / Math.max(1, decisions.length))]),
         [1]),
       `${recovered} of ${decisions.length} recovered`, true))}
     ${section("Case by case", card("", table(["case", "at risk", "rail", "concluded", "confidence", "citing", "outcome"], rows, [1, 4]), "", true))}`,
  );
}
