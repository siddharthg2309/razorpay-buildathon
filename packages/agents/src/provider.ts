import type { RoleId } from "@rra/core";

export type Effort = "none" | "low" | "medium" | "high";

export interface ProviderRequest {
  role: RoleId | "deliberation_reducer";
  /**
   * Stable across every case at this call site: role instructions, the sorted
   * action library, the policy summary, the decline taxonomy. Kept first so the
   * prefix caches.
   */
  instructions: string;
  /** Case-specific, bounded, PII-redacted. Always last. */
  input: string;
  schema: Record<string, unknown>;
  schemaName: string;
  schemaVersion: string;
  model: string;
  effort: Effort;
  cacheKey: string;
  timeoutMs: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ProviderResponse<T> {
  value: T;
  provider: string;
  model: string;
  responseId: string;
  latencyMs: number;
  usage: ProviderUsage;
  /** False when the response failed schema validation and was rejected. */
  validated: boolean;
}

export class ProviderUnavailableError extends Error {
  constructor(provider: string, cause: string) {
    super(`${provider} unavailable: ${cause}`);
    this.name = "ProviderUnavailableError";
  }
}

export class SchemaValidationError extends Error {
  constructor(schemaName: string, detail: string) {
    super(`response failed ${schemaName} validation: ${detail}`);
    this.name = "SchemaValidationError";
  }
}

/**
 * The provider seam. Roles depend on this, never on a vendor SDK — the model is
 * an implementation detail inside a role, not the architecture.
 */
export interface LLMProvider {
  readonly name: string;
  complete<T>(req: ProviderRequest): Promise<ProviderResponse<T>>;
}
