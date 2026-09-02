import { createHash } from "node:crypto";

export interface StratumInput {
  caseId: string;
  cause: string;
  amountPaise: number;
}

/** Value bands, so a holdout cannot end up systematically cheaper than treated. */
export const VALUE_BANDS = [
  { label: "lt_1k", maxPaise: 100_000 },
  { label: "1k_5k", maxPaise: 500_000 },
  { label: "5k_25k", maxPaise: 2_500_000 },
  { label: "gt_25k", maxPaise: Number.MAX_SAFE_INTEGER },
] as const;

export const valueBand = (amountPaise: number): string =>
  VALUE_BANDS.find((b) => amountPaise <= b.maxPaise)!.label;

export const stratumOf = (input: StratumInput): string =>
  `${input.cause}:${valueBand(input.amountPaise)}`;

/**
 * Deterministic per-case assignment.
 *
 * Hashing (seed, stratum, caseId) rather than drawing from a shared RNG means
 * assignment does not depend on the order cases happen to be created in — so a
 * replay with the same seed produces the identical split even if the batch is
 * generated concurrently.
 */
export function assignHoldout(input: StratumInput, holdoutRate: number, seed: number): boolean {
  const stratum = stratumOf(input);
  const digest = createHash("sha256").update(`${seed}|${stratum}|${input.caseId}`).digest();
  // First 6 bytes give plenty of resolution and stay inside a safe integer.
  const draw = digest.readUIntBE(0, 6) / 0xffffffffffff;
  return draw < holdoutRate;
}

export interface StratumBalance {
  stratum: string;
  treated: number;
  holdout: number;
  holdoutShare: number;
}

export function balance(
  assignments: readonly { stratum: string; holdout: boolean }[],
): StratumBalance[] {
  const byStratum = new Map<string, { treated: number; holdout: number }>();
  for (const a of assignments) {
    const row = byStratum.get(a.stratum) ?? { treated: 0, holdout: 0 };
    if (a.holdout) row.holdout++;
    else row.treated++;
    byStratum.set(a.stratum, row);
  }
  return [...byStratum.entries()]
    .map(([stratum, r]) => ({
      stratum,
      treated: r.treated,
      holdout: r.holdout,
      holdoutShare: r.holdout / (r.treated + r.holdout),
    }))
    .sort((a, b) => a.stratum.localeCompare(b.stratum));
}
