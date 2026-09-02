import { mulberry32 } from "./rng.js";

export interface CaseOutcome {
  caseId: string;
  holdout: boolean;
  recovered: boolean;
  amountPaise: number;
  /** Milliseconds from case creation to recovery, when it recovered. */
  recoveredAfterMs?: number;
  /** True when the merchant's own dunning collected it. */
  merchantDunning?: boolean;
}

export interface EstimatorConfig {
  /**
   * Recoveries landing inside this window from case creation are excluded from
   * BOTH arms.
   *
   * Applied symmetrically on purpose. A contact-relative rule ("exclude
   * self-service retries before first agent contact") subtracts those
   * recoveries from the treated arm only — the holdout has no contact, so its
   * equivalents stay in the numerator — and the estimate is biased upward.
   */
  naturalRecoveryWindowMs: number;
  windowDays: number;
  bootstrapSamples: number;
  seed: number;
}

export const DEFAULT_ESTIMATOR_CONFIG: EstimatorConfig = {
  naturalRecoveryWindowMs: 30 * 60_000,
  windowDays: 14,
  bootstrapSamples: 2000,
  seed: 20260902,
};

export interface AttributionResult {
  treatedN: number;
  holdoutN: number;
  treatedRecovered: number;
  holdoutRecovered: number;
  treatedRate: number;
  holdoutRate: number;
  lift: number;
  liftCi: [number, number];
  grossRecoveredPaise: number;
  incrementalPaise: number;
  incrementalCi: [number, number];
  excludedTreated: number;
  excludedHoldout: number;
  meanValueAtRiskPaise: number;
}

const isExcluded = (o: CaseOutcome, c: EstimatorConfig): boolean => {
  if (o.merchantDunning) return true;
  return (
    o.recovered &&
    o.recoveredAfterMs !== undefined &&
    o.recoveredAfterMs < c.naturalRecoveryWindowMs
  );
};

/**
 * Incremental recovery against a randomised holdout.
 *
 *   incremental = (rate_treated - rate_holdout) x treated_volume x mean_value
 *
 * Gross recovery is also reported, and the two are never conflated: gross is
 * the money that arrived, incremental is the money the agent caused.
 */
export function estimate(
  outcomes: readonly CaseOutcome[],
  config: EstimatorConfig = DEFAULT_ESTIMATOR_CONFIG,
): AttributionResult {
  const excludedTreated = outcomes.filter((o) => !o.holdout && isExcluded(o, config)).length;
  const excludedHoldout = outcomes.filter((o) => o.holdout && isExcluded(o, config)).length;

  const eligible = outcomes.filter((o) => !isExcluded(o, config));
  const treated = eligible.filter((o) => !o.holdout);
  const holdout = eligible.filter((o) => o.holdout);

  const treatedRecovered = treated.filter((o) => o.recovered).length;
  const holdoutRecovered = holdout.filter((o) => o.recovered).length;
  const treatedRate = treated.length === 0 ? 0 : treatedRecovered / treated.length;
  const holdoutRate = holdout.length === 0 ? 0 : holdoutRecovered / holdout.length;
  const lift = treatedRate - holdoutRate;

  const meanValue =
    treated.length === 0 ? 0 : treated.reduce((s, o) => s + o.amountPaise, 0) / treated.length;

  // The interval is driven by the holdout arm, which is the small one.
  const seTreated = treated.length ? (treatedRate * (1 - treatedRate)) / treated.length : 0;
  const seHoldout = holdout.length ? (holdoutRate * (1 - holdoutRate)) / holdout.length : 0;
  const se = Math.sqrt(seTreated + seHoldout);
  const liftCi: [number, number] = [lift - 1.96 * se, lift + 1.96 * se];

  const grossRecoveredPaise = treated
    .filter((o) => o.recovered)
    .reduce((s, o) => s + o.amountPaise, 0);
  const incrementalPaise = Math.round(lift * treated.length * meanValue);

  return {
    treatedN: treated.length,
    holdoutN: holdout.length,
    treatedRecovered,
    holdoutRecovered,
    treatedRate,
    holdoutRate,
    lift,
    liftCi,
    grossRecoveredPaise,
    incrementalPaise,
    incrementalCi: bootstrapIncremental(treated, holdout, config),
    excludedTreated,
    excludedHoldout,
    meanValueAtRiskPaise: Math.round(meanValue),
  };
}

/**
 * Bootstrap on rupees rather than propagating the rate interval, because the
 * value distribution is lognormal — a handful of large obligations dominate,
 * and a normal approximation understates the spread.
 */
function bootstrapIncremental(
  treated: readonly CaseOutcome[],
  holdout: readonly CaseOutcome[],
  config: EstimatorConfig,
): [number, number] {
  if (treated.length === 0 || holdout.length === 0) return [0, 0];
  const rand = mulberry32(config.seed);
  const samples: number[] = [];

  for (let i = 0; i < config.bootstrapSamples; i++) {
    let tRecovered = 0;
    let tValue = 0;
    for (let j = 0; j < treated.length; j++) {
      const pick = treated[Math.floor(rand() * treated.length)]!;
      if (pick.recovered) tRecovered++;
      tValue += pick.amountPaise;
    }
    let hRecovered = 0;
    for (let j = 0; j < holdout.length; j++) {
      if (holdout[Math.floor(rand() * holdout.length)]!.recovered) hRecovered++;
    }
    const l = tRecovered / treated.length - hRecovered / holdout.length;
    samples.push(l * treated.length * (tValue / treated.length));
  }

  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(0.025 * samples.length)] ?? 0;
  const hi = samples[Math.floor(0.975 * samples.length)] ?? 0;
  return [Math.round(lo), Math.round(hi)];
}

/**
 * The simulator's ground truth, available only because the world is synthetic.
 * A case counts as truly caused when it recovered and the latent
 * willPayRegardless flag says it would not have paid on its own.
 */
export function trueIncremental(
  outcomes: readonly (CaseOutcome & { willPayRegardless: boolean })[],
): number {
  return outcomes
    .filter((o) => !o.holdout && o.recovered && !o.willPayRegardless)
    .reduce((s, o) => s + o.amountPaise, 0);
}
