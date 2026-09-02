/** Statistics for the anomaly detector. Pure, so they are testable in isolation. */

/** Abramowitz & Stegun 7.1.26 — plenty for a detector threshold. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

export interface ZTestResult {
  z: number;
  /** One-sided: probability of a drop this large or larger under the baseline. */
  pValue: number;
  observedRate: number;
  baselineRate: number;
}

/**
 * One-sided two-proportion z-test for a *drop* in approval rate.
 *
 * One-sided on purpose: a segment approving better than baseline is not an
 * incident, and testing two-sided would spend half the significance budget on
 * an outcome nobody wants to page about.
 */
export function twoProportionZTest(
  approvals: number,
  attempts: number,
  baselineApprovals: number,
  baselineAttempts: number,
): ZTestResult {
  const observedRate = attempts === 0 ? 0 : approvals / attempts;
  const baselineRate = baselineAttempts === 0 ? 0 : baselineApprovals / baselineAttempts;
  if (attempts === 0 || baselineAttempts === 0) {
    return { z: 0, pValue: 1, observedRate, baselineRate };
  }
  const pooled = (approvals + baselineApprovals) / (attempts + baselineAttempts);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / attempts + 1 / baselineAttempts));
  if (se === 0) return { z: 0, pValue: 1, observedRate, baselineRate };
  const z = (observedRate - baselineRate) / se;
  return { z, pValue: normalCdf(z), observedRate, baselineRate };
}

/**
 * Benjamini-Hochberg. Hundreds of segments are tested per tick, so an
 * uncorrected 0.05 threshold produces a handful of incidents per tick from
 * noise alone — which is precisely the "forty incidents" failure.
 */
export function benjaminiHochberg<T>(
  items: readonly T[],
  pValue: (item: T) => number,
  alpha = 0.05,
): T[] {
  const sorted = [...items].sort((a, b) => pValue(a) - pValue(b));
  const m = sorted.length;
  let cutoff = -1;
  for (let i = 0; i < m; i++) {
    if (pValue(sorted[i]!) <= ((i + 1) / m) * alpha) cutoff = i;
  }
  return cutoff === -1 ? [] : sorted.slice(0, cutoff + 1);
}

/** Wilson score interval — behaves at small n where the normal interval does not. */
export function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}
