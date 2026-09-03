import { getPool } from "@rra/db";
import { bar, esc, kpi, page, panel, pct, rupees, table } from "../render.js";

interface Arm {
  arm: string;
  incremental_paise: string;
  lift: number;
  treated_n: number;
  provider_calls: number;
}

/**
 * What deliberation actually contributed.
 *
 * The screen leads with the noise band rather than the difference, because a
 * batch total cannot resolve a change confined to a few percent of cases, and a
 * bare rupee figure invites over-reading in whichever direction it happens to
 * point.
 */
export async function ablationScreen(): Promise<string> {
  const { rows: arms } = await getPool().query<Arm>(
    `SELECT DISTINCT ON (arm) arm, incremental_paise, lift, treated_n, provider_calls
       FROM attribution_runs ORDER BY arm, created_at DESC`,
  );
  const full = arms.find((a) => a.arm === "full");
  const control = arms.find((a) => a.arm === "tier0_only");

  if (!full || !control) {
    return page("ablation", "ablation", panel("no ablation yet",
      `<p class="note">Run <code>npm run batch scenarios/demo.yaml -- --ablate</code>.
       It runs the same seed and the same world twice, once with the specialists
       deliberating and once with a generic per-rail playbook.</p>`));
  }

  const delta = Number(full.incremental_paise) - Number(control.incremental_paise);

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

  // The band a batch total cannot see through, given how few cases differ.
  const differing = decisions.length || full.treated_n;
  const meanValue = decisions.length
    ? decisions.reduce((s, d) => s + Number(d.amount_paise), 0) / decisions.length
    : 0;
  const noiseBand = Math.round(1.96 * Math.sqrt(differing) * meanValue * 0.5);
  const readable = Math.abs(delta) > noiseBand;

  const recovered = decisions.filter((d) => d.state === "RECOVERED").length;

  const rows = decisions.slice(0, 40).map((d) => [
    `<a href="/case/${esc(d.case_id)}">${esc(d.case_id)}</a>`,
    rupees(Number(d.amount_paise)),
    `<span class="dim">${esc(d.rail ?? "—")}</span>`,
    esc(String(d.payload["primaryCause"] ?? d.payload["intent"] ?? "—")),
    d.confidence !== null ? d.confidence.toFixed(2) : "—",
    `<span class="mono-sm">${esc(d.model ?? "—")} · ${d.latency_ms ?? "?"}ms</span>`,
    `<span class="mono-sm">${esc((d.evidence_refs ?? []).join(", "))}</span>`,
    `<span class="state-${esc(d.state)}">${esc(d.state)}</span>`,
  ]);

  const causeSpread = new Map<string, number>();
  for (const d of decisions) {
    const c = String(d.payload["primaryCause"] ?? "—");
    causeSpread.set(c, (causeSpread.get(c) ?? 0) + 1);
  }

  return page(
    "ablation",
    "ablation",
    `<h1>What deliberation contributed</h1>
     <div class="kpis">
       ${kpi(rupees(Number(full.incremental_paise)), "with deliberation", `lift ${pct(full.lift)} · ${full.provider_calls} provider calls`)}
       ${kpi(rupees(Number(control.incremental_paise)), "tier-0 control", `lift ${pct(control.lift)} · generic per-rail playbook`)}
       ${kpi(rupees(delta), "difference", `over ${differing} cases`, readable)}
       ${kpi(`± ${rupees(noiseBand)}`, "noise band", readable ? "difference is readable" : "difference is not")}
     </div>
     ${panel(
       readable ? "readable" : "not distinguishable from zero",
       readable
         ? `<p class="note">The difference exceeds what the batch total can move on noise alone,
            so it is worth reading. It measures deliberation against a <em>generic default</em> —
            not against a hand-written rule set over the same retrieved context. A determined
            engineer could encode some of this judgement in rules; what the model buys is not
            having to anticipate every code an issuer might invent.</p>`
         : `<p class="note">The arms differ on ${differing} cases, and a batch total cannot resolve a
            difference that small. The honest reading is that deliberation did not measurably move
            the batch — and the claim worth making is per-case, below.</p>`,
     )}
     ${panel(
       "diagnoses the model reached",
       table(
         ["cause", "cases", ""],
         [...causeSpread.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => [
           esc(c), String(n), bar(n / Math.max(1, decisions.length)),
         ]),
         [1],
       ) + `<p class="note" style="margin-top:12px">${recovered} of ${decisions.length} of these
       reached RECOVERED. Every row below carries the model, the latency and the evidence it cited,
       so the reasoning can be checked rather than taken.</p>`,
     )}
     ${panel(
       "the cases Tier 0 could not answer",
       rows.length
         ? table(["case", "at risk", "rail", "concluded", "conf", "model", "cited", "outcome"], rows, [1, 4])
         : `<p class="note">None — no provider was configured for this run.</p>`,
     )}
     <p class="mono-sm">Everything else in the batch was resolved deterministically from the
     decline taxonomy and is identical in both arms. This screen is the whole of the model's
     contribution, stated at the size it actually is.</p>`,
  );
}
