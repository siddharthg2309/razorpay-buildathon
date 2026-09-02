import OpenAI from "openai";
import type { Clock } from "@rra/core";
import {
  ProviderUnavailableError,
  SchemaValidationError,
  type LLMProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./provider.js";

export interface OpenAIProviderOptions {
  apiKey?: string;
  client?: OpenAI;
}

/**
 * The first implementation of LLMProvider.
 *
 * Uses the Responses API with strict Structured Outputs. A response that fails
 * schema validation is rejected rather than coerced — the engine must never
 * parse prose, and a half-valid claim is worse than no claim because the
 * reducer would treat it as evidence.
 */
export class OpenAIResponsesProvider implements LLMProvider {
  readonly name = "openai";
  readonly #client: OpenAI;

  constructor(
    private readonly clock: Clock,
    opts: OpenAIProviderOptions = {},
  ) {
    this.#client =
      opts.client ?? new OpenAI({ apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"] });
  }

  async complete<T>(req: ProviderRequest): Promise<ProviderResponse<T>> {
    const started = this.clock.now().getTime();
    let res;
    try {
      res = await this.#client.responses.create(
        {
          model: req.model,
          instructions: req.instructions,
          input: req.input,
          text: {
            format: {
              type: "json_schema",
              name: req.schemaName,
              schema: req.schema,
              strict: true,
            },
          },
          ...(req.effort === "none" ? {} : { reasoning: { effort: req.effort } }),
          prompt_cache_key: req.cacheKey,
        } as never,
        { timeout: req.timeoutMs },
      );
    } catch (err) {
      throw new ProviderUnavailableError(this.name, (err as Error).message);
    }

    const raw = (res as { output_text?: string }).output_text;
    if (!raw) throw new SchemaValidationError(req.schemaName, "empty response");

    let value: T;
    try {
      value = JSON.parse(raw) as T;
    } catch {
      throw new SchemaValidationError(req.schemaName, "response was not valid JSON");
    }

    const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }).usage;
    return {
      value,
      provider: this.name,
      model: req.model,
      responseId: (res as { id?: string }).id ?? "unknown",
      latencyMs: this.clock.now().getTime() - started,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      validated: true,
    };
  }
}
