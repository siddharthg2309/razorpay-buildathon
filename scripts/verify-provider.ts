/**
 * Checks whichever LLM backend is configured, without ever printing the key.
 *
 * Everything reported is derived — a length, a prefix, a boolean, a latency —
 * so the credential cannot end up in a terminal, a screenshot or a transcript.
 * Provider errors are redacted before printing, because they sometimes echo
 * request context back.
 */
import { RealClock } from "@rra/core";
import { OpenRouterProvider, selectProvider } from "@rra/agents";

const line = (ok: boolean, label: string, detail = ""): boolean => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

const clock = new RealClock();
const selected = selectProvider(clock);
const key =
  process.env["OPENROUTER_API_KEY"]?.trim() || process.env["OPENAI_API_KEY"]?.trim() || "";

console.log(`provider check — ${selected.kind}\n`);

if (selected.kind === "none") {
  line(false, "no key configured", "paste one into .env on the OPENROUTER_API_KEY= line");
  console.log("\nwithout a key the engine still runs end to end: Tier 0 carries ~95% of");
  console.log("cases and Tier 1 escalates in degraded mode. The ablation cannot measure");
  console.log("anything, and /ablation will be empty.");
  process.exit(1);
}

let ok = true;
ok = line(true, "key present", `${key.length} chars, starts "${key.slice(0, 3)}…"`) && ok;
ok = line(!/\s/.test(key), "no stray whitespace or quotes") && ok;
if (selected.kind === "openrouter") {
  ok = line(key.startsWith("sk-or-"), "looks like an OpenRouter key", key.startsWith("sk-or-") ? "" : "OpenRouter keys start sk-or-") && ok;
}
if (!ok) {
  console.log("\nfix .env and re-run");
  process.exit(1);
}

// A wrong model id is the commonest configuration mistake and gives a 404 that
// reads like an outage, so check it against the catalogue before calling.
const models = [
  ["diagnosis", selected.models.diagnosis],
  ["context", selected.models.context],
  ["reducer", selected.models.reducer],
] as const;

if (selected.kind === "openrouter") {
  try {
    const catalogue = new Set(await new OpenRouterProvider(clock).listModels());
    if (catalogue.size > 0) {
      for (const [role, id] of models) {
        ok = line(catalogue.has(id), `model for ${role}`, id) && ok;
      }
      if (!ok) {
        const sample = [...catalogue].filter((m) => m.includes("gpt") || m.includes("claude")).slice(0, 6);
        console.log(`\n  some available ids: ${sample.join(", ")}`);
        console.log("  set MODEL_DIAGNOSIS / MODEL_CONTEXT / MODEL_REDUCER in .env");
        process.exit(1);
      }
    }
  } catch {
    console.log("  (could not fetch the model catalogue; continuing to the live call)");
  }
} else {
  for (const [role, id] of models) line(true, `model for ${role}`, id);
}

const model = selected.models.context;
console.log(`\n  calling ${model} with a throwaway schema…`);

try {
  const res = await selected.provider!.complete<{ ok: boolean }>({
    role: "customer_context",
    instructions: 'Reply with {"ok": true}. Nothing else.',
    input: "health check",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
    schemaName: "health_check",
    schemaVersion: "1",
    model,
    effort: "none",
    cacheKey: "health_check:v1",
    timeoutMs: 30_000,
  });
  line(true, "call succeeded", `${res.model} · ${res.latencyMs}ms · ${res.usage.inputTokens} in / ${res.usage.outputTokens} out`);
  line(res.validated, "response validated against the schema");
  console.log(`\n${selected.kind} works. Run:`);
  console.log("  npm run batch scenarios/demo.yaml -- --ablate");
  console.log("to measure what deliberation actually contributes.");
} catch (err) {
  const message = (err as Error).message.replace(key, "[redacted]");
  line(false, "call failed", message.slice(0, 220));
  if (/402|credit/i.test(message)) console.log("\n  out of credits — top up and re-run");
  if (/404|not found|no endpoints/i.test(message)) {
    console.log("\n  that model id is not served. Set MODEL_* in .env to one that is.");
  }
  if (/structured|json_schema|response_format/i.test(message)) {
    console.log("\n  that model does not support structured outputs. Pick one that does —");
    console.log("  the engine refuses prose, so an unstructured model cannot be used.");
  }
  process.exit(1);
}
