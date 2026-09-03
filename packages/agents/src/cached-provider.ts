import { createHash } from "node:crypto";
import type { Clock } from "@rra/core";
import { getPool } from "@rra/db";
import type { LLMProvider, ProviderRequest, ProviderResponse } from "./provider.js";

export interface CacheStats {
  hits: number;
  misses: number;
}

/**
 * Caches validated provider output by role and input hash.
 *
 * The provider is the only non-deterministic element in an otherwise
 * reproducible batch, so a rehearsal of the same seed produces a slightly
 * different number every time and cannot be compared against the last one.
 * With the cache, a second run reproduces exactly and costs nothing.
 *
 * Keyed on the input, not the case: two cases presenting identical evidence
 * deserve the same answer, and keying on case id would defeat the point.
 *
 * The cache is transparent rather than hidden. Every hit is counted and the
 * response is labelled cached, so a replayed answer cannot be mistaken for a
 * fresh one.
 */
export class CachedProvider implements LLMProvider {
  readonly name: string;
  readonly stats: CacheStats = { hits: 0, misses: 0 };

  constructor(
    private readonly inner: LLMProvider,
    private readonly clock: Clock,
    private readonly enabled = true,
  ) {
    this.name = `${inner.name}+cache`;
  }

  static keyFor(req: ProviderRequest): string {
    // Instructions are part of the key. Changing the prompt must not silently
    // serve answers produced under the old one.
    return createHash("sha256")
      .update(
        [
          req.role,
          req.schemaName,
          req.schemaVersion,
          req.model,
          req.instructions,
          req.input,
        ].join(" "),
      )
      .digest("hex");
  }

  async complete<T>(req: ProviderRequest): Promise<ProviderResponse<T>> {
    if (!this.enabled) return this.inner.complete<T>(req);

    const key = CachedProvider.keyFor(req);
    const { rows } = await getPool().query<{
      payload: T;
      model: string;
      usage: ProviderResponse<T>["usage"];
      latency_ms: number;
    }>("SELECT payload, model, usage, latency_ms FROM claim_cache WHERE cache_key = $1", [key]);

    const hit = rows[0];
    if (hit) {
      this.stats.hits++;
      await getPool().query(
        "UPDATE claim_cache SET hits = hits + 1, last_hit_at = $2 WHERE cache_key = $1",
        [key, this.clock.now()],
      );
      return {
        value: hit.payload,
        provider: `${this.inner.name}(cached)`,
        model: hit.model,
        responseId: `cache:${key.slice(0, 12)}`,
        latencyMs: hit.latency_ms,
        usage: hit.usage,
        validated: true,
      };
    }

    this.stats.misses++;
    const res = await this.inner.complete<T>(req);

    // Only validated responses are cached. Storing a rejected one would serve a
    // schema violation from cache for as long as the cache lives.
    if (res.validated) {
      await getPool().query(
        `INSERT INTO claim_cache
           (cache_key, role, input_hash, schema_version, model, payload, usage, latency_ms, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (cache_key) DO NOTHING`,
        [
          key,
          req.role,
          key.slice(0, 32),
          req.schemaVersion,
          res.model,
          JSON.stringify(res.value),
          JSON.stringify(res.usage),
          res.latencyMs,
          this.clock.now(),
        ],
      );
    }
    return res;
  }
}
