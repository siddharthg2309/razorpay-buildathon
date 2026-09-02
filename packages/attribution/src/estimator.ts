import { mulberry32 } from "./rng.js";
import { valueBand } from "./holdout.js";

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
  /** Value-band-stratified form, reported as a diagnostic beside the headline. */
  incrementalStratifiedPaise: number;
  /** Per-band contributions, so the headline can be audited band by band. */
  strata: {
    band: string;
    treatedN: number;
    holdoutN: number;
    lift: number;
    meanValuePaise: number;
    incrementalPaise: number;
    pooledFallback: boolean;
  }[];
  excludedTreated: number;
  excludedHoldout: number;
  meanValueAtRiskPaise: number;
}

/** Minimum holdout cases in a band before its own lift is trusted. */
const MIN_BAND_HOLDOUT = 20;

function estimateByBand(
  treated: readonly CaseOutcome[],
  holdout: readonly CaseOutcome[],
  pooledLift: number,
): AttributionResult["strata"] {
  const bands = [...new Set([...treated, ...holdout].map((o) => valueBand(o.amountPaise)))].sort();

  return bands.map((band) => {
    const t = treated.filter((o) => valueBand(o.amountPaise) === band);
    const h = holdout.filter((o) => valueBand(o.amountPaise) === band);
    const tRate = t.length ? t.filter((o) => o.recovered).length / t.length : 0;
    const hRate = h.length ? h.filter((o) => o.recovered).length / h.length : 0;

    // A thin band's own lift is noise. Borrow the pooled lift rather than
    // letting one or two holdout cases swing the whole band.
    const pooledFallback = h.length < MIN_BAND_HOLDOUT;
    const bandLift = pooledFallback ? pooledLift : tRate - hRate;

    // Price the band at the value of the cases that actually recovered in it,
    // falling back to the band mean when none did.
    const recoveredInBand = t.filter((o) => o.recovered);
    const meanValuePaise = recoveredInBand.length
      ? recoveredInBand.reduce((s, o) => s + o.amountPaise, 0) / recoveredInBand.length
      : t.length
        ? t.reduce((s, o) => s + o.amountPaise, 0) / t.length
        : 0;

    return {
      band,
      treatedN: t.length,
      holdoutN: h.length,
      lift: bandLift,
      meanValuePaise: Math.round(meanValuePaise),
      incrementalPaise: Math.round(bandLift * t.length * meanValuePaise),
      pooledFallback,
    };
  });
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

  // The headline is the form architecture §10 specifies.
  //
  // A value-band-stratified variant was tried and made the point estimate
  // worse, not better. The residual error is not a pricing problem: it is
  // chance imbalance between the arms on an unobservable covariate — in the
  // synthetic world, the share of customers who would have paid anyway differs
  // between arms by ~2pp at this holdout size. Stratifying on value amplifies
  // that imbalance rather than correcting it, and nothing observable can
  // correct it. That is precisely what the confidence interval is for, so the
  // simpler specified estimator is the headline and the stratified breakdown
  // is kept as a diagnostic.
  const strata = estimateByBand(treated, holdout, lift);
  const incrementalStratifiedPaise = Math.round(
    strata.reduce((sum, s) => sum + s.incrementalPaise, 0),
  );
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
    incrementalStratifiedPaise,
    strata,
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
    // Resample both arms and recompute the same value-weighted statistic, so
    // the interval is an interval on the number actually reported.
    let tGross = 0;
    let tRecoveredCount = 0;
    let tValue = 0;
    for (let j = 0; j < treated.length; j++) {
      const pick = treated[Math.floor(rand() * treated.length)]!;
      if (pick.recovered) {
        tGross += pick.amountPaise;
        tRecoveredCount++;
      }
      tValue += pick.amountPaise;
    }
    const tMeanValue = tValue / treated.length;
    let hRecovered = 0;
    let hValue = 0;
    for (let j = 0; j < holdout.length; j++) {
      const pick = holdout[Math.floor(rand() * holdout.length)]!;
      if (pick.recovered) {
        hRecovered++;
        hValue += pick.amountPaise;
      }
    }
    void tGross;
    void hValue;
    const l = tRecoveredCount / treated.length - hRecovered / holdout.length;
    samples.push(l * treated.length * tMeanValue);
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
