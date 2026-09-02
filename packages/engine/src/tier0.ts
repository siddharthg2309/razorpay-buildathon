import type {
  Classification,
  DeclineTaxonomy,
  Domain,
  Plan,
  PlaybookTable,
  Rail,
} from "@rra/core";

export type Tier0Outcome =
  | { resolved: true; classification: Classification; plan: Plan }
  | { resolved: false; reason: Tier0Miss; classification: Classification | null };

export type Tier0Miss =
  | "unmapped_code"          // no taxonomy entry — the model earns its place here
  | "no_playbook"            // cause known, but no default plan for this domain
  | "retry_ceiling_reached"  // known and retryable, but the code's ceiling is spent
  | "below_confidence";      // taxonomy match too weak to act on alone

export interface Tier0Input {
  domain: Domain;
  rail: Rail;
  code: string;
  attemptNo: number;
}

/**
 * The deterministic resolver. Handles the ~80% of cases where the rail and the
 * code fully determine what to do, with zero model calls and a rule_id that
 * makes the decision reproducible on replay.
 *
 * Every miss is a named reason rather than a silent fallthrough, because the
 * demo claim is "the model changed the outcome on N cases" — which requires
 * knowing exactly why each of those N escalated.
 */
export class Tier0Resolver {
  constructor(
    private readonly taxonomy: DeclineTaxonomy,
    private readonly playbooks: PlaybookTable,
    private readonly minConfidence = 0.75,
  ) {}

  resolve(input: Tier0Input): Tier0Outcome {
    const classification = this.taxonomy.classify(input.rail, input.code, input.attemptNo);
    if (!classification) {
      return { resolved: false, reason: "unmapped_code", classification: null };
    }
    if (classification.confidence < this.minConfidence) {
      return { resolved: false, reason: "below_confidence", classification };
    }
    // A soft decline whose ceiling is spent is no longer a Tier 0 case: the
    // default plan would retry, and the ceiling exists to stop exactly that.
    if (classification.retryEligible && !classification.retryPermitted) {
      return { resolved: false, reason: "retry_ceiling_reached", classification };
    }
    const plan = this.playbooks.planFor(input.domain, classification.cause);
    if (!plan) {
      return { resolved: false, reason: "no_playbook", classification };
    }
    return { resolved: true, classification, plan };
  }
}
