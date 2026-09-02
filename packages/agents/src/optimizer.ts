import type { ActionLibrary } from "@rra/core";
import type { EconomicsCandidate } from "./claims.js";

export interface ScoredAction extends EconomicsCandidate {
  modelCostPaise: number;
  riskPenaltyPaise: number;
  score: number;
  rank: number;
}

export interface OptimizerResult {
  selected: ScoredAction | null;
  ranked: ScoredAction[];
  rejected: { actionId: string; why: string }[];
}

export interface OptimizerConstraints {
  /** Action ids the policy engine permits for this case right now. */
  permitted: readonly string[];
  /** Contacting a fatigued customer has a cost the EV alone does not capture. */
  priorContacts: number;
  modelSpendPaise: number;
}

/**
 * The constrained optimizer.
 *
 * It ranks; it does not invent. Candidates come from the economics claim, which
 * enumerates the action library — so the optimizer cannot select a novel action
 * even if scoring one would look attractive.
 */
export class ConstrainedOptimizer {
  constructor(
    private readonly library: ActionLibrary,
    /** Paise of penalty per prior contact, applied to contacting actions. */
    private readonly contactFatiguePaise = 1500,
  ) {}

  rank(candidates: readonly EconomicsCandidate[], c: OptimizerConstraints): OptimizerResult {
    const rejected: { actionId: string; why: string }[] = [];
    const scored: ScoredAction[] = [];

    for (const cand of candidates) {
      if (!c.permitted.includes(cand.actionId)) {
        rejected.push({ actionId: cand.actionId, why: "not permitted by policy for this case" });
        continue;
      }
      let action;
      try {
        action = this.library.get(cand.actionId);
      } catch (err) {
        // A candidate naming an unknown or forbidden action is dropped loudly.
        rejected.push({ actionId: cand.actionId, why: (err as Error).message });
        continue;
      }

      const riskPenaltyPaise = action.consumesContactBudget
        ? c.priorContacts * this.contactFatiguePaise
        : 0;
      const score = cand.expectedValuePaise - c.modelSpendPaise - riskPenaltyPaise;
      scored.push({ ...cand, modelCostPaise: c.modelSpendPaise, riskPenaltyPaise, score, rank: 0 });
    }

    // Tie-break on action id so the ranking is stable across replays.
    scored.sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId));
    scored.forEach((s, i) => (s.rank = i + 1));

    // A negative-value action is worse than doing nothing: recovering ₹100 by
    // spending ₹150 of contact and model budget is not a recovery.
    const positive = scored.filter((s) => s.score > 0);
    for (const s of scored) {
      if (s.score <= 0) rejected.push({ actionId: s.actionId, why: `expected value ${s.score} is not positive` });
    }

    return { selected: positive[0] ?? null, ranked: scored, rejected };
  }
}
