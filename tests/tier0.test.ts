import { describe, expect, it } from "vitest";
import { loadConfig, parseTaxonomy } from "@rra/core";
import { Tier0Resolver } from "@rra/engine";

const config = loadConfig();
const tier0 = new Tier0Resolver(config.taxonomy, config.playbooks);

describe("decline taxonomy", () => {
  it("refuses to load a hard decline marked retryable", () => {
    expect(() =>
      parseTaxonomy(`version: 1
codes:
  - { rail: card, code: EXPIRED_CARD, cause: expired_card, hardness: hard, retry_eligible: true, retry_ceiling: 2, confidence: 0.9, rule_id: X }
`),
    ).toThrow(/hard decline but marked retry_eligible/);
  });

  it("rejects duplicate (rail, code) pairs", () => {
    expect(() =>
      parseTaxonomy(`version: 1
codes:
  - { rail: card, code: DUP, cause: a, hardness: soft, retry_eligible: true, retry_ceiling: 1, confidence: 0.9, rule_id: X }
  - { rail: card, code: DUP, cause: b, hardness: soft, retry_eligible: true, retry_ceiling: 1, confidence: 0.9, rule_id: Y }
`),
    ).toThrow(/duplicate taxonomy entry/);
  });

  it("keys on rail, so the same code means different things per rail", () => {
    const card = config.taxonomy.classify("card", "INSUFFICIENT_FUNDS");
    const enach = config.taxonomy.classify("enach", "INSUFFICIENT_FUNDS");
    expect(card?.ruleId).toBe("T0-CARD-001");
    expect(enach?.ruleId).toBe("T0-NACH-003");
    expect(card?.retryCeiling).not.toBe(enach?.retryCeiling);
  });

  it("never permits a retry on a revoked mandate", () => {
    for (const [rail, code] of [
      ["upi_autopay", "MANDATE_REVOKED"],
      ["enach", "MANDATE_NOT_ACTIVE"],
    ] as const) {
      const c = config.taxonomy.classify(rail, code, 0);
      expect(c?.hardness).toBe("hard");
      expect(c?.retryEligible).toBe(false);
      expect(c?.retryPermitted).toBe(false);
    }
  });

  it("spends the per-code ceiling as attempts accumulate", () => {
    expect(config.taxonomy.classify("card", "INSUFFICIENT_FUNDS", 0)?.retryPermitted).toBe(true);
    expect(config.taxonomy.classify("card", "INSUFFICIENT_FUNDS", 2)?.retryPermitted).toBe(true);
    expect(config.taxonomy.classify("card", "INSUFFICIENT_FUNDS", 3)?.retryPermitted).toBe(false);
  });
});

describe("playbooks", () => {
  it("validates every step against the action library at load", () => {
    for (const pb of config.playbooks.all()) {
      for (const step of pb.steps) expect(config.library.has(step.actionId)).toBe(true);
    }
  });

  it("never schedules a forbidden action", () => {
    for (const pb of config.playbooks.all()) {
      for (const step of pb.steps) {
        expect(["charge_retry", "update_routing", "send_message"]).not.toContain(step.actionId);
      }
    }
  });
});

describe("Tier 0 resolver", () => {
  it("resolves the acceptance case with no model call", () => {
    const out = tier0.resolve({
      domain: "subscription_renewal",
      rail: "upi_autopay",
      code: "INSUFFICIENT_FUNDS",
      attemptNo: 0,
    });
    expect(out.resolved).toBe(true);
    if (!out.resolved) return;
    expect(out.classification.cause).toBe("insufficient_funds");
    expect(out.classification.confidence).toBe(0.95);
    expect(out.classification.ruleId).toBe("T0-UPI-004");
    expect(out.plan.ruleId).toBe("PB-SUB-001");
    expect(out.plan.steps.map((s) => s.actionId)).toEqual([
      "send_approved_template",
      "wait",
      "await_provider_retry",
    ]);
    expect(out.plan.chosenBy).toBe("tier0_playbook");
  });

  it("is reproducible — the same input yields the identical plan", () => {
    const input = { domain: "payment_failure", rail: "card", code: "EXPIRED_CARD", attemptNo: 0 } as const;
    expect(tier0.resolve(input)).toEqual(tier0.resolve(input));
  });

  it("escalates an unmapped code, which is how Tier 1 earns its place", () => {
    const out = tier0.resolve({
      domain: "payment_failure",
      rail: "card",
      code: "SOME_NEW_ISSUER_CODE",
      attemptNo: 0,
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toBe("unmapped_code");
    expect(out.classification).toBeNull();
  });

  it("escalates when the ceiling is spent rather than retrying anyway", () => {
    const out = tier0.resolve({
      domain: "payment_failure",
      rail: "card",
      code: "INSUFFICIENT_FUNDS",
      attemptNo: 3,
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toBe("retry_ceiling_reached");
    expect(out.classification?.cause).toBe("insufficient_funds");
  });

  it("escalates a known cause with no playbook for the domain", () => {
    const out = tier0.resolve({
      domain: "overdue_invoice",
      rail: "card",
      code: "OTP_FAILURE",
      attemptNo: 0,
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toBe("no_playbook");
  });

  it("routes a revoked mandate to an update request, never a retry", () => {
    const out = tier0.resolve({
      domain: "subscription_renewal",
      rail: "upi_autopay",
      code: "MANDATE_REVOKED",
      attemptNo: 0,
    });
    expect(out.resolved).toBe(true);
    if (!out.resolved) return;
    const ids = out.plan.steps.map((s) => s.actionId);
    expect(ids[0]).toBe("request_payment_method_update");
    expect(ids).not.toContain("await_provider_retry");
  });

  it("orders the pre-debit prerequisite before the provider retry", () => {
    const out = tier0.resolve({
      domain: "subscription_renewal",
      rail: "upi_autopay",
      code: "MANDATE_AMOUNT_EXCEEDED",
      attemptNo: 0,
    });
    expect(out.resolved).toBe(true);
    if (!out.resolved) return;
    const ids = out.plan.steps.map((s) => s.actionId);
    expect(ids.indexOf("await_mandate_prerequisite")).toBeLessThan(ids.indexOf("await_provider_retry"));
  });

  it("never contacts the customer on a fraud signal", () => {
    const out = tier0.resolve({
      domain: "payment_failure",
      rail: "card",
      code: "STOLEN_CARD",
      attemptNo: 0,
    });
    expect(out.resolved).toBe(true);
    if (!out.resolved) return;
    expect(out.plan.steps.map((s) => s.actionId)).toEqual(["create_ops_escalation"]);
  });
});
