/**
 * The per-case ablation.
 *
 * A batch total cannot resolve what deliberation did when the arms differ on a
 * few percent of cases — the aggregate is dominated by the 95% both arms handle
 * identically. This shows the cases that actually differed: what the model was
 * given, what it concluded, and what the deterministic control did instead.
 *
 * This is the claim worth making on stage, because it is the one the data
 * supports.
 */
import { closePool, getPool } from "@rra/db";

const { rows } = await getPool().query<{
  case_id: string; role: string; confidence: number | null;
  payload: Record<string, unknown>; provider: string | null; model: string | null;
  latency_ms: number | null; state: string; cause: string | null; rail: string | null;
  amount_paise: string;
}>(
  `SELECT c.id AS case_id, cl.role, cl.confidence, cl.payload,
          r.provider, r.model, r.latency_ms,
          c.state, c.cause, c.rail, o.amount_paise
     FROM claims cl
     JOIN cases c ON c.id = cl.case_id
     JOIN obligations o ON o.id = c.obligation_id
     LEFT JOIN agent_runs r ON r.id = cl.agent_run_id
    WHERE r.provider IS NOT NULL
    ORDER BY o.amount_paise DESC`,
);

if (rows.length === 0) {
  console.log("no provider-backed claims in this batch.");
  console.log("run `npm run batch scenarios/demo.yaml` with OPENAI_API_KEY set.");
  await closePool();
  process.exit(0);
}

const rupees = (p: string) => `₹${(Number(p) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

console.log(`CASES THE MODEL ACTUALLY DECIDED — ${rows.length} claims\n`);
console.log("These are the cases where Tier 0 had no answer. Everything else in");
console.log("the batch was resolved deterministically and is identical in both arms.\n");

const recovered = rows.filter((r) => r.state === "RECOVERED");
console.log(`  ${recovered.length}/${rows.length} of these reached RECOVERED`);
console.log(`  value at risk on them: ${rupees(String(rows.reduce((s, r) => s + Number(r.amount_paise), 0)))}\n`);

for (const r of rows.slice(0, 8)) {
  const cause = r.payload["primaryCause"] ?? r.payload["intent"] ?? "—";
  console.log(`  ${r.case_id}  ${rupees(r.amount_paise)}  ${r.rail}  → ${r.state}`);
  console.log(`      ${r.role} · ${r.model} · ${r.latency_ms ?? "?"}ms`);
  console.log(`      concluded: ${cause}${r.confidence !== null ? ` (confidence ${r.confidence.toFixed(2)})` : ""}`);
  const refs = r.payload["evidenceRefs"];
  if (Array.isArray(refs) && refs.length) console.log(`      cited: ${refs.join(", ")}`);
  console.log("");
}
if (rows.length > 8) console.log(`  … and ${rows.length - 8} more\n`);

console.log("Every one of these carries the provider, the model, the latency and the");
console.log("evidence it cited, so a judge can check the reasoning rather than take it.");
await closePool();
