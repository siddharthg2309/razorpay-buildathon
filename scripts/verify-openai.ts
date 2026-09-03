/**
 * Checks the OpenAI key works, without ever printing it.
 *
 * Everything reported here is derived — a length, a prefix shape, a boolean —
 * so the key cannot end up in a terminal, a screenshot, or a transcript. If a
 * check needs the key itself to be legible to be useful, it does not belong.
 */
import { RealClock } from "@rra/core";
import { OpenAIResponsesProvider } from "@rra/agents";

const key = process.env["OPENAI_API_KEY"]?.trim();

const line = (ok: boolean, label: string, detail = ""): boolean => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

console.log("openai key check\n");

if (!key) {
  line(false, "OPENAI_API_KEY set", "paste it into .env on the OPENAI_API_KEY= line");
  console.log("\nwithout a key the engine still runs: Tier 0 carries ~95% of cases and");
  console.log("Tier 1 escalates in degraded mode. The ablation cannot measure anything.");
  process.exit(1);
}

let ok = true;
// Shape only. Never the value.
ok = line(true, "OPENAI_API_KEY set", `${key.length} chars, starts "${key.slice(0, 3)}…"`) && ok;
ok = line(key.startsWith("sk-"), "looks like an OpenAI key") && ok;
ok = line(!/\s/.test(key), "no stray whitespace or quotes") && ok;

if (!ok) {
  console.log("\nfix .env and re-run");
  process.exit(1);
}

const model = process.argv[2] ?? "gpt-5.6-luna";
console.log(`\n  calling ${model} with a throwaway schema…`);

try {
  const provider = new OpenAIResponsesProvider(new RealClock());
  const res = await provider.complete<{ ok: boolean }>({
    role: "customer_context",
    instructions: "Reply with {\"ok\": true}. Nothing else.",
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
  console.log("\nkey works. run `npm run batch scenarios/demo.yaml -- --ablate` to measure");
  console.log("what deliberation actually contributes.");
} catch (err) {
  const message = (err as Error).message;
  // Redact defensively: provider errors sometimes echo request context.
  line(false, "call failed", message.replace(key, "[redacted]").slice(0, 200));
  console.log("\nif the model name is wrong, pass one: npm run verify:openai -- gpt-5.6-terra");
  process.exit(1);
}
