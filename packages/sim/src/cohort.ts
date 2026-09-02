import type { DeclineTaxonomy, Domain, Rail } from "@rra/core";
import { mulberry32 } from "@rra/attribution";
import type { Scenario } from "./scenario.js";

export interface LatentState {
  /** Would have paid with no intervention at all. The natural-recovery flag. */
  willPayRegardless: boolean;
  /** When they would have paid, if they would have. */
  naturalPaymentAtMs: number | null;
  hasFundsAfterMs: number;
  respondsToLink: number;
  cardExpired: boolean;
  mandateState: "active" | "paused" | "revoked";
  willOptOut: boolean;
  willDispute: boolean;
}

export interface SyntheticCase {
  caseId: string;
  customerId: string;
  obligationId: string;
  externalRef: string;
  domain: Domain;
  rail: Rail;
  cause: string;
  code: string;
  amountPaise: number;
  gateway: string;
  issuer: string;
  latent: LatentState;
}

/** Draws a key from a weighted distribution. */
function pick<T extends string>(dist: Record<T, number>, r: number): T {
  let acc = 0;
  for (const [key, weight] of Object.entries(dist) as [T, number][]) {
    acc += weight;
    if (r < acc) return key;
  }
  return Object.keys(dist)[Object.keys(dist).length - 1] as T;
}

/** Box-Muller, so the value distribution is genuinely lognormal. */
function lognormal(rand: () => number, mu: number, sigma: number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * z);
}

const GATEWAYS = ["A", "B"];
const ISSUERS = ["HDFC", "ICICI", "SBI", "AXIS"];

/**
 * Generates the cohort from the scenario's distributions.
 *
 * Cause is conditioned on rail rather than drawn independently: a revoked
 * mandate has no meaning on a wallet, and an unconditioned draw would produce
 * (rail, cause) pairs the taxonomy cannot classify — which would inflate the
 * Tier 1 rate with impossible cases rather than genuinely ambiguous ones.
 */
export function generateCohort(scenario: Scenario, taxonomy: DeclineTaxonomy): SyntheticCase[] {
  const rand = mulberry32(scenario.seed);
  const cases: SyntheticCase[] = [];

  for (let i = 0; i < scenario.size; i++) {
    const id = String(i).padStart(5, "0");
    const domain = pick(scenario.domains, rand());
    const rail = pick(scenario.rails, rand());
    let cause = pick(scenario.causes, rand());

    // The deliberate unmapped slice: an issuer code the taxonomy has never
    // seen, which is what routes a case to Tier 1.
    let code: string;
    if (cause === "unmapped_code") {
      code = `ISSUER_${Math.floor(rand() * 900 + 100)}`;
    } else {
      let codes = taxonomy.codesForCause(rail, cause);
      if (codes.length === 0) {
        // Impossible pairing — redraw the cause from what this rail can produce.
        const available = taxonomy.causesFor(rail);
        cause = available[Math.floor(rand() * available.length)]!;
        codes = taxonomy.codesForCause(rail, cause);
      }
      code = codes[Math.floor(rand() * codes.length)]!;
    }

    const amountPaise = Math.round(lognormal(rand, scenario.valueDistribution.mu, scenario.valueDistribution.sigma) * 100);

    const willPayRegardless = rand() < scenario.world.naturalRecoveryRate;
    const naturalPaymentAtMs = willPayRegardless
      ? Math.floor(rand() * scenario.windowDays * 86_400_000)
      : null;

    cases.push({
      caseId: `c_${id}`,
      customerId: `cu_${id}`,
      obligationId: `ob_${id}`,
      externalRef: `ext_${id}`,
      domain,
      rail,
      cause,
      code,
      amountPaise,
      gateway: GATEWAYS[Math.floor(rand() * GATEWAYS.length)]!,
      issuer: ISSUERS[Math.floor(rand() * ISSUERS.length)]!,
      latent: {
        willPayRegardless,
        naturalPaymentAtMs,
        hasFundsAfterMs:
          cause === "insufficient_funds" ? scenario.world.fundsClearAfterHours * 3_600_000 : 0,
        respondsToLink: scenario.world.respondsToLink,
        cardExpired: cause === "expired_card",
        mandateState: cause === "mandate_revoked" ? "revoked" : "active",
        willOptOut: rand() < scenario.world.optOutRate,
        willDispute: rand() < scenario.world.disputeRate,
      },
    });
  }
  return cases;
}
