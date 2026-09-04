import type { Clock } from "@rra/core";
import {
  ProviderUnavailableError,
  SchemaValidationError,
  type LLMProvider,
  type ProviderRequest,
  type ProviderResponse,
} from "./provider.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Sent so usage shows up attributed on the OpenRouter dashboard. */
  referer?: string;
  title?: string;
}

interface ChatCompletion {
  id?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string };
}

/**
 * OpenRouter implementation of LLMProvider.
 *
 * OpenRouter speaks Chat Completions, not the Responses API, so this is a
 * separate adapter rather than a base-url swap on the OpenAI one. Everything
 * the engine depends on is preserved: strict JSON-schema output, a validated
 * response or none at all, and usage recorded for the ledger.
 *
 * Structured output goes through `response_format: json_schema` with
 * `strict: true`. A model that does not support it returns prose, which fails
 * validation here rather than reaching the reducer as if it were a claim.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  readonly #key: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(
    private readonly clock: Clock,
    opts: OpenRouterOptions = {},
  ) {
    const key = opts.apiKey ?? process.env["OPENROUTER_API_KEY"];
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    this.#key = key;
    this.#baseUrl = opts.baseUrl ?? process.env["OPENROUTER_BASE_URL"] ?? OPENROUTER_BASE;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#headers = {
      Authorization: `Bearer ${this.#key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": opts.referer ?? "https://github.com/revenue-recovery-agent",
      "X-Title": opts.title ?? "Revenue Recovery Agent",
    };
  }

  async complete<T>(req: ProviderRequest): Promise<ProviderResponse<T>> {
    const started = this.clock.now().getTime();

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.#headers,
        signal: AbortSignal.timeout(req.timeoutMs),
        body: JSON.stringify({
          model: req.model,
          // Stable instructions first so the prefix caches on providers that
          // support it; case-specific evidence last.
          messages: [
            { role: "system", content: req.instructions },
            { role: "user", content: req.input },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: req.schemaName, strict: true, schema: req.schema },
          },
          temperature: 0,
        }),
      });
    } catch (err) {
      throw new ProviderUnavailableError(this.name, (err as Error).message);
    }

    const body = (await res.json().catch(() => ({}))) as ChatCompletion;

    if (!res.ok) {
      // Carry the provider's own message through — a 402 for credits and a 404
      // for a bad model id need different fixes, and a generic failure hides
      // which one you have.
      const detail = body.error?.message ?? `HTTP ${res.status}`;
      throw new ProviderUnavailableError(this.name, `${res.status}: ${detail}`);
    }

    const raw = body.choices?.[0]?.message?.content;
    if (!raw) throw new SchemaValidationError(req.schemaName, "empty response");

    let value: T;
    try {
      value = JSON.parse(raw) as T;
    } catch {
      // A model that ignored the schema returns prose. Rejecting here keeps it
      // out of the claim board entirely.
      throw new SchemaValidationError(req.schemaName, "response was not valid JSON");
    }

    return {
      value,
      provider: this.name,
      model: req.model,
      responseId: body.id ?? "unknown",
      latencyMs: this.clock.now().getTime() - started,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        // OpenRouter does not report cached prompt tokens uniformly across
        // upstreams, so this stays zero rather than being guessed at.
        cachedInputTokens: 0,
      },
      validated: true,
    };
  }

  /** Model ids currently served, for validating configuration before a run. */
  async listModels(): Promise<string[]> {
    const res = await this.#fetch(`${this.#baseUrl}/models`, { headers: this.#headers });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
  }
}
