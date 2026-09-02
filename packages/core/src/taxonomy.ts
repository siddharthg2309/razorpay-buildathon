import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Rail } from "./types.js";

export type Hardness = "hard" | "soft";

export interface DeclineEntry {
  rail: Rail;
  code: string;
  cause: string;
  hardness: Hardness;
  retryEligible: boolean;
  retryCeiling: number;
  confidence: number;
  ruleId: string;
}

/** What Tier 0 produces. A null classification is the escalation signal. */
export interface Classification {
  cause: string;
  confidence: number;
  ruleId: string;
  hardness: Hardness;
  retryEligible: boolean;
  retryCeiling: number;
  /** False once attempts have consumed the per-code ceiling. */
  retryPermitted: boolean;
}

export class DeclineTaxonomy {
  readonly version: number;
  readonly #byRailCode: ReadonlyMap<string, DeclineEntry>;

  constructor(version: number, entries: readonly DeclineEntry[]) {
    this.version = version;
    this.#byRailCode = new Map(entries.map((e) => [`${e.rail}::${e.code}`, e]));
  }

  /**
   * Deterministic classifier. Returns null for an unmapped (rail, code), which
   * is how a case reaches Tier 1 — the absence of a rule, not a low score.
   */
  classify(rail: Rail, code: string, attemptNo = 0): Classification | null {
    const entry = this.#byRailCode.get(`${rail}::${code}`);
    if (!entry) return null;
    return {
      cause: entry.cause,
      confidence: entry.confidence,
      ruleId: entry.ruleId,
      hardness: entry.hardness,
      retryEligible: entry.retryEligible,
      retryCeiling: entry.retryCeiling,
      retryPermitted: entry.retryEligible && attemptNo < entry.retryCeiling,
    };
  }

  entries(): readonly DeclineEntry[] {
    return [...this.#byRailCode.values()];
  }

  codesFor(rail: Rail): readonly string[] {
    return this.entries().filter((e) => e.rail === rail).map((e) => e.code).sort();
  }
}

interface RawCode {
  rail: Rail;
  code: string;
  cause: string;
  hardness: Hardness;
  retry_eligible: boolean;
  retry_ceiling: number;
  confidence: number;
  rule_id: string;
}

export function parseTaxonomy(source: string): DeclineTaxonomy {
  const raw = parse(source) as { version: number; codes: RawCode[] };
  const seen = new Set<string>();
  const entries = raw.codes.map((c): DeclineEntry => {
    const key = `${c.rail}::${c.code}`;
    if (seen.has(key)) throw new Error(`duplicate taxonomy entry: ${key}`);
    seen.add(key);
    // A hard decline with retries permitted is the exact mistake the taxonomy
    // exists to prevent, so it fails at load rather than at runtime.
    if (c.hardness === "hard" && c.retry_eligible) {
      throw new Error(`${key} is a hard decline but marked retry_eligible`);
    }
    return {
      rail: c.rail,
      code: c.code,
      cause: c.cause,
      hardness: c.hardness,
      retryEligible: c.retry_eligible,
      retryCeiling: c.retry_ceiling,
      confidence: c.confidence,
      ruleId: c.rule_id,
    };
  });
  return new DeclineTaxonomy(raw.version, entries);
}

export const loadTaxonomy = (path: string): DeclineTaxonomy =>
  parseTaxonomy(readFileSync(path, "utf8"));
