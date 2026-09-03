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
  /** Present only on the deliberately ambiguous slice. */
  ambiguous?: AmbiguousContext;
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
 * Opaque codes an issuer or PSP can return that our taxonomy has never seen.
 *
 * They are deliberately uninformative. An earlier version generated codes like
 * `ISSUER_437`, which told the reader the answer in the string itself — the
 * model concluded `issuer_decline` on every one, and the ablation measured a
 * model reading a label rather than diagnosing anything. Real unmapped codes
 * look like these: short, numeric or alphanumeric, and meaningless without
 * context.
 */
const OPAQUE_CODES = [
  "05", "12", "13", "19", "41", "43", "51", "57", "58", "61", "62", "65",
  "75", "91", "96", "N7", "R0", "R1", "Z1", "Z3", "M01", "M02", "U29",
  "1A", "B2", "DN", "XS", "TO", "E04", "P18",
];

/**
 * Context the model has to reason over, since the code tells it nothing.
 *
 * Each ambiguous case gets facts that point in different directions — a live
 * mandate alongside a failed debit, or prior successes alongside a decline —
 * so the diagnosis requires weighing evidence rather than pattern-matching a
 * string.
 */
export interface AmbiguousContext {
  /** Only present on rails that actually carry a mandate. */
  mandateActive?: boolean;
  mandateCapPaise?: number | null;
  priorSuccesses: number;
  balanceSufficient: boolean;
  segmentDegraded: boolean;
  attemptedAmountPaise: number;
  cardExpired?: boolean;
  [key: string]: unknown;
}

/** Mandate facts only mean something where a mandate exists. */
const MANDATE_RAILS = new Set<Rail>(["upi_autopay", "enach"]);

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
    let ambiguous: AmbiguousContext | undefined;
    if (cause === "unmapped_code") {
      code = OPAQUE_CODES[Math.floor(rand() * OPAQUE_CODES.length)]!;
      // Facts that genuinely conflict, so there is something to weigh — but
      // only facts that can exist on this rail. Handing a card case a mandate
      // state invites a diagnosis that is impossible for the instrument, and a
      // model that answers `mandate_paused` for a card has been misled by the
      // harness rather than caught reasoning badly.
      const onMandateRail = MANDATE_RAILS.has(rail);
      const capBreach = onMandateRail && rand() < 0.35;
      ambiguous = {
        priorSuccesses: Math.floor(rand() * 4),
        balanceSufficient: rand() < 0.55,
        segmentDegraded: rand() < 0.2,
        attemptedAmountPaise: 0, // filled below, once the amount is drawn
        ...(onMandateRail
          ? { mandateActive: rand() < 0.75, mandateCapPaise: capBreach ? 0 : null }
          : { cardExpired: rail === "card" && rand() < 0.2 }),
      };
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

    if (ambiguous) {
      ambiguous.attemptedAmountPaise = amountPaise;
      // A cap below the attempt is one plausible explanation among several.
      if (ambiguous.mandateCapPaise !== null && ambiguous.mandateCapPaise !== undefined) {
        ambiguous.mandateCapPaise = Math.floor(amountPaise * (0.4 + rand() * 0.4));
      }
    }

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
      ...(ambiguous ? { ambiguous } : {}),
    });
  }
  return cases;
}
