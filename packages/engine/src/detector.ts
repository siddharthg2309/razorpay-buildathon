import { benjaminiHochberg, twoProportionZTest, type Clock, type ZTestResult } from "@rra/core";

export type SegmentKey = Partial<{
  gateway: string;
  method: string;
  issuer: string;
  region: string;
  device: string;
}>;

const DIMS = ["gateway", "method", "issuer", "region", "device"] as const;

export const segmentLabel = (k: SegmentKey): string =>
  DIMS.filter((d) => k[d] !== undefined).map((d) => `${d}=${k[d]}`).join("&") || "all";

/** True when `parent` is a strictly coarser segment containing `child`. */
export function isAncestor(parent: SegmentKey, child: SegmentKey): boolean {
  const pDims = DIMS.filter((d) => parent[d] !== undefined);
  const cDims = DIMS.filter((d) => child[d] !== undefined);
  if (pDims.length >= cDims.length) return false;
  return pDims.every((d) => parent[d] === child[d]);
}

export interface SegmentObservation {
  segment: SegmentKey;
  attempts: number;
  approvals: number;
  baselineAttempts: number;
  baselineApprovals: number;
}

export interface Candidate {
  segment: SegmentKey;
  label: string;
  test: ZTestResult;
  attempts: number;
}

export interface DetectorConfig {
  /** No test below this — small samples produce spurious z-scores. */
  volumeFloor: number;
  alpha: number;
  /** Consecutive windows a segment must fail before an incident opens. */
  dwellWindows: number;
  /** Rate within this fraction of baseline for N windows closes the incident. */
  closeWithin: number;
  closeWindows: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  volumeFloor: 30,
  alpha: 0.05,
  dwellWindows: 2,
  closeWithin: 0.95,
  closeWindows: 3,
};

/**
 * Segmented anomaly detector.
 *
 * The naive version — rolling window against an aggregate baseline — fires on
 * mix shift: a marketing push changes the issuer mix, the aggregate rate drops,
 * and nothing is actually broken. Every element here exists to stop a specific
 * false positive:
 *
 *   volume floor   - small-n noise
 *   seasonal per-segment baseline - mix shift and time-of-day effects
 *   dwell          - single-window blips
 *   BH correction  - testing hundreds of segments at once
 *   child suppression - one gateway failure becoming forty incidents
 */
export class AnomalyDetector {
  /** segment label -> consecutive failing windows. */
  readonly #dwell = new Map<string, number>();
  /** segment label -> consecutive healthy windows. */
  readonly #healthy = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
  ) {}

  /**
   * Evaluate one tick. Returns only the segments that should open an incident:
   * significant after correction, past dwell, and not explained by a parent.
   */
  evaluate(observations: readonly SegmentObservation[]): Candidate[] {
    const tested: Candidate[] = observations
      .filter((o) => o.attempts >= this.config.volumeFloor)
      .map((o) => ({
        segment: o.segment,
        label: segmentLabel(o.segment),
        attempts: o.attempts,
        test: twoProportionZTest(o.approvals, o.attempts, o.baselineApprovals, o.baselineAttempts),
      }));

    // Only drops are incidents.
    const drops = tested.filter((c) => c.test.z < 0);
    const significant = benjaminiHochberg(drops, (c) => c.test.pValue, this.config.alpha);
    const significantLabels = new Set(significant.map((c) => c.label));

    // Update hysteresis for every tested segment, not just significant ones —
    // a segment that recovers must lose its dwell count.
    for (const c of tested) {
      if (significantLabels.has(c.label)) {
        this.#dwell.set(c.label, (this.#dwell.get(c.label) ?? 0) + 1);
        this.#healthy.set(c.label, 0);
      } else {
        this.#dwell.set(c.label, 0);
        if (c.test.observedRate >= c.test.baselineRate * this.config.closeWithin) {
          this.#healthy.set(c.label, (this.#healthy.get(c.label) ?? 0) + 1);
        } else {
          this.#healthy.set(c.label, 0);
        }
      }
    }

    const dwelled = significant.filter(
      (c) => (this.#dwell.get(c.label) ?? 0) >= this.config.dwellWindows,
    );

    // Child suppression: if a coarser segment also fired, the finer one is
    // explained by it. Opening both is how one gateway outage becomes forty
    // incidents.
    return dwelled.filter(
      (c) => !dwelled.some((other) => other !== c && isAncestor(other.segment, c.segment)),
    );
  }

  /** True once a segment has been healthy for the configured run of windows. */
  shouldClose(label: string): boolean {
    return (this.#healthy.get(label) ?? 0) >= this.config.closeWindows;
  }

  dwellCount(label: string): number {
    return this.#dwell.get(label) ?? 0;
  }

  healthyCount(label: string): number {
    return this.#healthy.get(label) ?? 0;
  }

  reset(label: string): void {
    this.#dwell.delete(label);
    this.#healthy.delete(label);
  }
}
