import type { LLMProvider } from "./provider.js";
import { STRATEGY_SCHEMA, SCHEMA_VERSION, type DiagnosisClaim, type ContextClaim, type IncidentClaim } from "./claims.js";

export interface RejectedAlternative {
  cause: string;
  why: string;
}

export interface Strategy {
  selectedCause: string;
  confidence: number;
  suppress: boolean;
  stopReason: string | null;
  rationale: string;
  rejected: RejectedAlternative[];
  /** How the conflict was settled — recorded in the ledger. */
  resolvedBy: "single_hypothesis" | "precedence_rule" | "confidence_margin" | "provider" | "escalate";
}

export interface ReducerInput {
  diagnosis: DiagnosisClaim;
  context: ContextClaim;
  incident: IncidentClaim;
}

/** Below this gap between the top two hypotheses, the conflict is material. */
const MATERIAL_MARGIN = 0.15;

/**
 * The deliberation reducer.
 *
 * Deterministic precedence first, provider only for a genuinely material
 * conflict. It returns a strategy and its rejected alternatives — never an
 * executable connector call, which is the boundary that keeps the model out of
 * the money path.
 */
export class DeliberationReducer {
  constructor(
    private readonly provider: LLMProvider | null = null,
    private readonly model = "gpt-5.6-terra",
  ) {}

  async reduce(input: ReducerInput): Promise<Strategy> {
    const { diagnosis, context, incident } = input;

    // Precedence 1: an opt-out or dispute ends the case regardless of what the
    // other specialists concluded. Customer signals outrank machine inference.
    if (context.optedOut || context.intent === "opt_out") {
      return this.#stop("customer_opted_out", "customer opted out of contact", diagnosis);
    }
    if (context.intent === "dispute") {
      return this.#stop("disputed", "customer disputed the obligation", diagnosis);
    }

    // Precedence 2: incident suppression outranks any per-case plan. Acting now
    // would retry into a gateway that is already failing.
    if (incident.suppress) {
      return {
        selectedCause: diagnosis.primaryCause,
        confidence: diagnosis.confidence,
        suppress: true,
        stopReason: null,
        rationale: incident.rationale,
        rejected: [],
        resolvedBy: "precedence_rule",
      };
    }

    if (diagnosis.alternatives.length === 0) {
      return {
        selectedCause: diagnosis.primaryCause,
        confidence: diagnosis.confidence,
        suppress: false,
        stopReason: null,
        rationale: diagnosis.ruleId
          ? `taxonomy rule ${diagnosis.ruleId} resolved the cause outright`
          : "single hypothesis with no competing alternative",
        rejected: [],
        resolvedBy: "single_hypothesis",
      };
    }

    const runnerUp = [...diagnosis.alternatives].sort((a, b) => b.confidence - a.confidence)[0]!;
    const margin = diagnosis.confidence - runnerUp.confidence;

    // A clear winner needs no adjudication.
    if (margin >= MATERIAL_MARGIN) {
      return {
        selectedCause: diagnosis.primaryCause,
        confidence: diagnosis.confidence,
        suppress: false,
        stopReason: null,
        rationale: `leading hypothesis clears the runner-up by ${margin.toFixed(2)}`,
        rejected: diagnosis.alternatives.map((a) => ({
          cause: a.cause,
          why: `confidence ${a.confidence.toFixed(2)} below the selected ${diagnosis.confidence.toFixed(2)}`,
        })),
        resolvedBy: "confidence_margin",
      };
    }

    // Genuinely material conflict: this is the only place the reducer spends a
    // provider call.
    if (!this.provider) {
      return this.#escalate(diagnosis, "hypotheses are too close to separate and no provider is available");
    }

    try {
      const res = await this.provider.complete<{
        selectedCause: string;
        confidence: number;
        rationale: string;
        rejected: RejectedAlternative[];
      }>({
        role: "deliberation_reducer",
        instructions: [
          "You adjudicate between competing diagnoses of a failed payment.",
          "Choose one cause and explain why each alternative was rejected.",
          "You cannot propose an action, a retry, or any contact. Choose a cause only.",
        ].join("\n"),
        input: JSON.stringify({
          primary: { cause: diagnosis.primaryCause, confidence: diagnosis.confidence },
          alternatives: diagnosis.alternatives,
          evidenceRefs: diagnosis.evidenceRefs,
        }),
        schema: STRATEGY_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "strategy",
        schemaVersion: SCHEMA_VERSION,
        model: this.model,
        effort: "high",
        cacheKey: `deliberation_reducer:v${SCHEMA_VERSION}`,
        timeoutMs: 10_000,
      });
      return {
        selectedCause: res.value.selectedCause,
        confidence: res.value.confidence,
        suppress: false,
        stopReason: null,
        rationale: res.value.rationale,
        rejected: res.value.rejected,
        resolvedBy: "provider",
      };
    } catch {
      // A provider outage must never manufacture a plan. Escalate instead.
      return this.#escalate(diagnosis, "provider unavailable while adjudicating a material conflict");
    }
  }

  #stop(reason: string, rationale: string, d: DiagnosisClaim): Strategy {
    return {
      selectedCause: d.primaryCause,
      confidence: d.confidence,
      suppress: false,
      stopReason: reason,
      rationale,
      rejected: [],
      resolvedBy: "precedence_rule",
    };
  }

  #escalate(d: DiagnosisClaim, why: string): Strategy {
    return {
      selectedCause: d.primaryCause,
      confidence: d.confidence,
      suppress: false,
      stopReason: "escalate_to_human",
      rationale: why,
      rejected: d.alternatives.map((a) => ({ cause: a.cause, why: "unresolved conflict" })),
      resolvedBy: "escalate",
    };
  }
}
