import { mulberry32 } from "@rra/connectors";
import type { Clock } from "@rra/core";
import { Ledger } from "@rra/db";
import type { IncidentManager } from "./incident.js";

export const RAMP_STAGES = [0.05, 0.15, 0.4, 1.0] as const;

export interface HealthReading {
  observedRate: number;
  baselineRate: number;
}

export interface ReleaseStep {
  stage: number;
  releasedNow: number;
  stillParked: number;
  action: "released" | "held" | "reparked" | "completed";
  reason: string;
}

export interface ReleaseConfig {
  /** Fraction of baseline the live rate must hold to advance. */
  healthThreshold: number;
  /** Spread within a stage so a batch does not land as one spike. */
  jitterFraction: number;
}

export const DEFAULT_RELEASE_CONFIG: ReleaseConfig = {
  healthThreshold: 0.9,
  jitterFraction: 0.2,
};

/**
 * Staged release with a circuit breaker.
 *
 * The failure this exists to prevent: a thousand parked cases resume at once
 * against a gateway that has only just recovered, re-degrade it, and the
 * detector fires again — self-inflicted oscillation. Cases return in ramped
 * slices, each gated on the live approval rate holding, and a drop mid-ramp
 * re-parks rather than pressing on.
 */
export class ReleaseController {
  private readonly ledger: Ledger;
  #rand: () => number;
  /** Cases released in the current stage, so the breaker knows what to pull back. */
  readonly #inFlight = new Map<string, string[]>();

  constructor(
    private readonly incidents: IncidentManager,
    private readonly clock: Clock,
    private readonly config: ReleaseConfig = DEFAULT_RELEASE_CONFIG,
    seed = 20260902,
  ) {
    this.ledger = new Ledger(clock);
    this.#rand = mulberry32(seed);
  }

  /**
   * Advance one step of the ramp. Call on a timer while an incident is
   * releasing; each call either releases a slice, holds, re-parks, or finishes.
   */
  async step(incidentId: string, health: HealthReading): Promise<ReleaseStep> {
    const incident = await this.incidents.get(incidentId);
    if (!incident) throw new Error(`unknown incident ${incidentId}`);

    const healthy =
      health.baselineRate === 0 ||
      health.observedRate >= health.baselineRate * this.config.healthThreshold;

    // Circuit breaker: pull back whatever this stage released rather than
    // continuing to ramp into a gateway that is failing again.
    if (!healthy) {
      const released = this.#inFlight.get(incidentId) ?? [];
      if (released.length > 0) {
        await this.incidents.repark(incidentId, released);
        this.#inFlight.set(incidentId, []);
      }
      await this.incidents.setState(incidentId, "open", 0);
      const step: ReleaseStep = {
        stage: 0,
        releasedNow: 0,
        stillParked: (await this.incidents.parkedCases(incidentId)).length,
        action: "reparked",
        reason: `approval rate ${health.observedRate.toFixed(3)} below ${(health.baselineRate * this.config.healthThreshold).toFixed(3)}`,
      };
      await this.#log(incidentId, step);
      return step;
    }

    const parked = await this.incidents.parkedCases(incidentId);
    if (parked.length === 0) {
      await this.incidents.setState(incidentId, "closed", RAMP_STAGES.length);
      const step: ReleaseStep = {
        stage: RAMP_STAGES.length, releasedNow: 0, stillParked: 0,
        action: "completed", reason: "every parked case has been released",
      };
      await this.#log(incidentId, step);
      return step;
    }

    const nextStage = incident.releaseStage;
    const fraction = RAMP_STAGES[Math.min(nextStage, RAMP_STAGES.length - 1)]!;

    // Jitter the slice size so a stage does not land as a single spike.
    const jitter = 1 + (this.#rand() * 2 - 1) * this.config.jitterFraction;
    const target = fraction === 1 ? parked.length : Math.max(1, Math.round(parked.length * fraction * jitter));
    const slice = parked.slice(0, Math.min(target, parked.length));

    await this.incidents.release(incidentId, slice);
    this.#inFlight.set(incidentId, slice);
    await this.incidents.setState(incidentId, "releasing", nextStage + 1);

    const stillParked = parked.length - slice.length;
    const step: ReleaseStep = {
      stage: nextStage + 1,
      releasedNow: slice.length,
      stillParked,
      action: "released",
      reason: `stage ${nextStage + 1}/${RAMP_STAGES.length} at ${(fraction * 100).toFixed(0)}% with jitter`,
    };
    await this.#log(incidentId, step);
    return step;
  }

  async #log(incidentId: string, step: ReleaseStep): Promise<void> {
    await this.ledger.append({
      caseId: incidentId,
      actor: "release_controller",
      eventType: `release_${step.action}`,
      payload: { ...step },
    });
  }
}

/**
 * A routing override is a proposal, never an execution.
 *
 * Blast radius is the whole reason: rerouting affects every payment on the
 * gateway, not one case. Until a supported external capability exists and is
 * verified, this stays simulated and approval-only, with a TTL so nothing
 * becomes permanent by being forgotten.
 */
export interface RoutingProposal {
  incidentId: string;
  fromGateway: string;
  toGateway: string;
  canaryPercent: number;
  ttlHours: number;
  surface: "simulated";
  requiresApproval: true;
  rollbackOn: string;
}

export function proposeReroute(
  incidentId: string,
  fromGateway: string,
  toGateway: string,
): RoutingProposal {
  return {
    incidentId,
    fromGateway,
    toGateway,
    canaryPercent: 5,
    ttlHours: 4,
    surface: "simulated",
    requiresApproval: true,
    rollbackOn: "backup path underperforms the primary over a rolling window",
  };
}
