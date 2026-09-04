import type { Clock } from "@rra/core";
import { CachedProvider } from "./cached-provider.js";
import { OpenAIResponsesProvider } from "./openai-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import type { LLMProvider } from "./provider.js";

/**
 * Model ids, per role, resolved from the environment.
 *
 * The architecture is explicit that model ids are configuration and not
 * business logic. OpenRouter names models `vendor/model`, OpenAI does not, so
 * the ids differ by provider and neither set is hardcoded into a role.
 */
export interface ModelConfig {
  diagnosis: string;
  context: string;
  reducer: string;
}

export function modelsFor(provider: "openrouter" | "openai"): ModelConfig {
  const env = (k: string, fallback: string): string => process.env[k]?.trim() || fallback;
  return provider === "openrouter"
    ? {
        diagnosis: env("MODEL_DIAGNOSIS", "openai/gpt-4o-mini"),
        context: env("MODEL_CONTEXT", "openai/gpt-4o-mini"),
        reducer: env("MODEL_REDUCER", "openai/gpt-4o-mini"),
      }
    : {
        diagnosis: env("MODEL_DIAGNOSIS", "gpt-5.6-terra"),
        context: env("MODEL_CONTEXT", "gpt-5.6-luna"),
        reducer: env("MODEL_REDUCER", "gpt-5.6-terra"),
      };
}

export interface SelectedProvider {
  provider: LLMProvider | null;
  /** Which backend was chosen, for the run header and the ledger. */
  kind: "openrouter" | "openai" | "none";
  models: ModelConfig;
  cached: boolean;
}

/**
 * Picks a provider from whatever credentials are present.
 *
 * OpenRouter wins when both are set, because it is the one you configure
 * deliberately — an OpenAI key left over in .env should not silently take
 * precedence over the backend you just chose.
 *
 * Returning null rather than throwing is deliberate: the engine runs without a
 * provider, Tier 0 carries most cases, and Tier 1 escalates in degraded mode.
 * A missing key is a reduced demo, not a broken one.
 */
export function selectProvider(clock: Clock): SelectedProvider {
  const cached = !process.env["NO_CLAIM_CACHE"];
  const wrap = (p: LLMProvider): LLMProvider =>
    cached ? new CachedProvider(p, clock, true) : p;

  if (process.env["OPENROUTER_API_KEY"]?.trim()) {
    return {
      provider: wrap(new OpenRouterProvider(clock)),
      kind: "openrouter",
      models: modelsFor("openrouter"),
      cached,
    };
  }
  if (process.env["OPENAI_API_KEY"]?.trim()) {
    return {
      provider: wrap(new OpenAIResponsesProvider(clock)),
      kind: "openai",
      models: modelsFor("openai"),
      cached,
    };
  }
  return { provider: null, kind: "none", models: modelsFor("openai"), cached };
}
