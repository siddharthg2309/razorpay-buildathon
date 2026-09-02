import type { PoolClient } from "pg";
import {
  CapabilityMinter,
  RULES,
  actionAllowedOnRail,
  hashParams,
  inQuietHours,
  capFor,
  globalCap,
  type ActionLibrary,
  type CapabilityToken,
  type Clock,
  type Policy,
  type PolicyDecision,
  type Rail,
} from "@rra/core";
import { getPool, withTransaction } from "@rra/db";

export interface EvaluationContext {
  caseId: string;
  obligationId: string;
  customerId: string;
  rail: Rail;
  actionId: string;
  params: Record<string, unknown>;
  attemptNo: number;
  amountPaise?: number;
  optedOut?: boolean;
}

export interface Authorization {
  decision: PolicyDecision;
  /** Present only when the decision allows. Nothing else can produce one. */
  token?: CapabilityToken;
}

/**
 * The policy engine, and the only minter of capability tokens.
 *
 * Evaluation order is deliberate: cheap structural checks first, then consent,
 * then the stateful budget checks that cost a database round trip. A blocked
 * action should never consume a budget.
 */
export class PolicyEngine {
  constructor(
    private readonly policy: Policy,
    private readonly library: ActionLibrary,
    private readonly minter: CapabilityMinter,
    private readonly clock: Clock,
  ) {}

  async authorize(ctx: EvaluationContext): Promise<Authorization> {
    const decision = await this.#evaluate(ctx);
    await this.#record(ctx, decision);
    if (decision.outcome !== "allow") return { decision };

    const action = this.library.get(ctx.actionId);
    const token = this.minter.mint({
      caseId: ctx.caseId,
      obligationId: ctx.obligationId,
      actionId: ctx.actionId,
      paramsHash: hashParams(ctx.params),
      attemptNo: ctx.attemptNo,
      amountCapPaise: action.amountCapped ? (ctx.amountPaise ?? 0) : null,
      policyVersion: this.policy.version,
      ruleId: decision.ruleId,
    });
    await this.#persistToken(ctx, token);
    return { decision, token };
  }

  async #evaluate(ctx: EvaluationContext): Promise<PolicyDecision> {
    const v = this.policy.version;
    const action = this.library.get(ctx.actionId); // throws on forbidden/unknown

    if (!actionAllowedOnRail(this.policy, ctx.rail, ctx.actionId)) {
      return {
        outcome: "block",
        ruleId: RULES.ACTION_NOT_ALLOWED_ON_RAIL,
        reason: `${ctx.actionId} is not permitted on ${ctx.rail}`,
        policyVersion: v,
      };
    }

    if (ctx.optedOut && action.consumesContactBudget) {
      return {
        outcome: "block",
        ruleId: RULES.OPTED_OUT,
        reason: "customer has opted out of contact",
        policyVersion: v,
      };
    }

    if (ctx.attemptNo >= this.policy.maxAttemptsPerCase) {
      return {
        outcome: "block",
        ruleId: RULES.RETRY_CAP,
        reason: `attempt ${ctx.attemptNo + 1} exceeds cap of ${this.policy.maxAttemptsPerCase}`,
        policyVersion: v,
      };
    }

    if (action.quietHoursEnforced && inQuietHours(this.clock.now(), this.policy)) {
      return {
        outcome: "block",
        ruleId: RULES.QUIET_HOURS,
        reason: `quiet hours ${this.policy.quietHours.start}-${this.policy.quietHours.end} ${this.policy.quietHours.timezone}`,
        policyVersion: v,
      };
    }

    if (action.consumesContactBudget) {
      const channel = String(ctx.params["channel"] ?? "sms");
      const exhausted = await this.#budgetExhausted(ctx.customerId, channel);
      if (exhausted) {
        return {
          outcome: "block",
          ruleId: RULES.CONTACT_BUDGET,
          reason: exhausted,
          policyVersion: v,
        };
      }
    }

    if (
      ctx.amountPaise !== undefined &&
      ctx.amountPaise > this.policy.requireApprovalAbovePaise
    ) {
      return {
        outcome: "require_approval",
        ruleId: RULES.AMOUNT_APPROVAL,
        reason: `${ctx.amountPaise} paise exceeds the ${this.policy.requireApprovalAbovePaise} auto-approval threshold`,
        policyVersion: v,
      };
    }

    return {
      outcome: "allow",
      ruleId: RULES.ALLOWED,
      reason: `permitted on ${ctx.rail} within caps`,
      policyVersion: v,
    };
  }

  /** Returns a reason string when a cap is spent, or null when there is room. */
  async #budgetExhausted(customerId: string, channel: string): Promise<string | null> {
    for (const cap of [capFor(this.policy, channel), globalCap(this.policy)]) {
      if (!cap) continue;
      const used = await this.usage(customerId, cap.channel, cap.windowDays);
      if (used >= cap.max) {
        return cap.channel === "*"
          ? `global contact cap ${cap.max}/${cap.windowDays}d reached (${used} used)`
          : `${channel} cap ${cap.max}/${cap.windowDays}d reached (${used} used)`;
      }
    }
    return null;
  }

  #windowStart(windowDays: number): Date {
    const ms = windowDays * 86_400_000;
    return new Date(Math.floor(this.clock.now().getTime() / ms) * ms);
  }

  async usage(customerId: string, channel: string, windowDays: number): Promise<number> {
    const { rows } = await getPool().query<{ used: number }>(
      "SELECT used FROM contact_budgets WHERE customer_id = $1 AND channel = $2 AND window_start = $3",
      [customerId, channel, this.#windowStart(windowDays)],
    );
    return rows[0]?.used ?? 0;
  }

  /**
   * Consumed at execution, not at authorization: a plan that is authorised but
   * never runs must not spend the customer's allowance. Increments the
   * per-channel and global counters atomically.
   */
  async consumeContactBudget(customerId: string, channel: string): Promise<void> {
    await withTransaction(async (client) => {
      for (const cap of [capFor(this.policy, channel), globalCap(this.policy)]) {
        if (!cap) continue;
        await client.query(
          `INSERT INTO contact_budgets (customer_id, channel, window_start, used, cap)
           VALUES ($1, $2, $3, 1, $4)
           ON CONFLICT (customer_id, channel, window_start)
           DO UPDATE SET used = contact_budgets.used + 1`,
          [customerId, cap.channel, this.#windowStart(cap.windowDays), cap.max],
        );
      }
    });
  }

  async #record(ctx: EvaluationContext, d: PolicyDecision, client?: PoolClient): Promise<void> {
    await (client ?? getPool()).query(
      `INSERT INTO policy_decisions (case_id, action_id, outcome, rule_id, reason, policy_version, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.caseId, ctx.actionId, d.outcome, d.ruleId, d.reason, d.policyVersion, this.clock.now()],
    );
  }

  async #persistToken(ctx: EvaluationContext, t: CapabilityToken): Promise<void> {
    await getPool().query(
      `INSERT INTO capability_tokens
         (id, case_id, obligation_id, action_id, params_hash, attempt_no, amount_cap, policy_version, rule_id, not_after, nonce, minted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        t.nonce, ctx.caseId, ctx.obligationId, t.actionId, t.paramsHash, t.attemptNo,
        t.amountCapPaise, t.policyVersion, t.ruleId, new Date(t.notAfter), t.nonce, this.clock.now(),
      ],
    );
  }

  /** How many times each rule blocked something — the Policy screen's number. */
  async blockCountsByRule(): Promise<Record<string, number>> {
    const { rows } = await getPool().query<{ rule_id: string; n: string }>(
      `SELECT rule_id, count(*) AS n FROM policy_decisions
        WHERE outcome = 'block' GROUP BY rule_id ORDER BY rule_id`,
    );
    return Object.fromEntries(rows.map((r) => [r.rule_id, Number(r.n)]));
  }
}
