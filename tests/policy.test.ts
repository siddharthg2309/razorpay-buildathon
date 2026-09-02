import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  CapabilityMinter,
  RULES,
  TokenRejectedError,
  VirtualClock,
  hashParams,
  inQuietHours,
  loadConfig,
  loadPolicy,
} from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { CaseManager, PolicyEngine, TokenBurner, TokenReplayError } from "@rra/engine";

const policy = loadPolicy(join(process.cwd(), "policies/acme-subscriptions.yaml"));
const config = loadConfig();
const KEY = Buffer.from("test-signing-key-not-for-production");

// 14:00 IST — comfortably inside contact hours.
const DAYTIME = new Date("2026-09-02T08:30:00Z");

function fixture(at = DAYTIME) {
  const clock = new VirtualClock(at);
  const minter = new CapabilityMinter(KEY, clock);
  return {
    clock,
    minter,
    burner: new TokenBurner(clock),
    engine: new PolicyEngine(policy, config.library, minter, clock),
    cases: new CaseManager(clock),
  };
}

async function seed(caseId: string, clock: VirtualClock, cases: CaseManager) {
  await getPool().query(`INSERT INTO merchants (id,name,policy_version) VALUES ('m_1','A','v7') ON CONFLICT DO NOTHING`);
  await getPool().query(`INSERT INTO customers (id,merchant_id) VALUES ('cu_1','m_1') ON CONFLICT DO NOTHING`);
  await cases.openOrAttach({
    caseId, merchantId: "m_1", customerId: "cu_1",
    obligationId: `ob_${caseId}`, externalRef: `ext_${caseId}`,
    domain: "subscription_renewal", amountPaise: 420_000, dueAt: clock.now(), holdout: false,
  });
}

const ctx = (caseId: string, over: Partial<Parameters<PolicyEngine["authorize"]>[0]> = {}) => ({
  caseId,
  obligationId: `ob_${caseId}`,
  customerId: "cu_1",
  rail: "upi_autopay" as const,
  actionId: "send_approved_template",
  params: { channel: "whatsapp", template_id: "WA_X", language: "hi", slots: {} },
  attemptNo: 0,
  ...over,
});

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE token_burns, capability_tokens, policy_decisions, contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE",
  );
});
afterAll(async () => { await closePool(); });

describe("quiet hours", () => {
  it("wraps midnight in the merchant timezone, not the server's", () => {
    // 22:41 IST = 17:11 UTC. Inside quiet hours despite being daytime UTC.
    expect(inQuietHours(new Date("2026-09-02T17:11:00Z"), policy)).toBe(true);
    // 09:00 IST exactly — the window has closed.
    expect(inQuietHours(new Date("2026-09-02T03:30:00Z"), policy)).toBe(false);
    // 03:00 IST — after midnight, still quiet.
    expect(inQuietHours(new Date("2026-09-01T21:30:00Z"), policy)).toBe(true);
    expect(inQuietHours(DAYTIME, policy)).toBe(false);
  });
});

describe("policy engine", () => {
  it("allows a permitted action and mints a token for it", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p1", clock, cases);
    const { decision, token } = await engine.authorize(ctx("c_p1"));
    expect(decision.outcome).toBe("allow");
    expect(decision.policyVersion).toBe("v7");
    expect(token).toBeDefined();
    expect(token?.actionId).toBe("send_approved_template");
  });

  it("blocks an action the rail does not permit, with a named rule", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p2", clock, cases);
    // create_payment_link is not on the upi_autopay allow-list.
    const { decision, token } = await engine.authorize(
      ctx("c_p2", { actionId: "create_payment_link", params: { amount: 1000, currency: "INR" } }),
    );
    expect(decision.outcome).toBe("block");
    expect(decision.ruleId).toBe(RULES.ACTION_NOT_ALLOWED_ON_RAIL);
    expect(decision.reason).toMatch(/not permitted on upi_autopay/);
    expect(token).toBeUndefined();
  });

  it("blocks contact during quiet hours and mints nothing", async () => {
    const { clock, engine, cases } = fixture(new Date("2026-09-02T17:11:00Z")); // 22:41 IST
    await seed("c_p3", clock, cases);
    const { decision, token } = await engine.authorize(ctx("c_p3"));
    expect(decision.outcome).toBe("block");
    expect(decision.ruleId).toBe(RULES.QUIET_HOURS);
    expect(token).toBeUndefined();
  });

  it("blocks an over-cap contact attempt with the rule that stopped it", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p4", clock, cases);

    // whatsapp cap is 3 per 7 days.
    for (let i = 0; i < 3; i++) {
      const { decision } = await engine.authorize(ctx("c_p4"));
      expect(decision.outcome).toBe("allow");
      await engine.consumeContactBudget("cu_1", "whatsapp");
    }
    const { decision, token } = await engine.authorize(ctx("c_p4"));
    expect(decision.outcome).toBe("block");
    expect(decision.ruleId).toBe(RULES.CONTACT_BUDGET);
    expect(decision.reason).toMatch(/whatsapp cap 3\/7d reached/);
    expect(token).toBeUndefined();
  });

  it("shares the global cap across channels, so per-channel caps cannot be stacked", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p5", clock, cases);

    // 3 whatsapp + 2 sms = 5, then the 6th of any kind trips the global cap
    // even though email's own cap (5) is untouched.
    for (let i = 0; i < 3; i++) await engine.consumeContactBudget("cu_1", "whatsapp");
    for (let i = 0; i < 2; i++) await engine.consumeContactBudget("cu_1", "sms");
    expect(await engine.usage("cu_1", "*", 7)).toBe(5);

    const sixth = await engine.authorize(ctx("c_p5", { params: { channel: "email", template_id: "T", language: "en", slots: {} } }));
    expect(sixth.decision.outcome).toBe("allow");
    await engine.consumeContactBudget("cu_1", "email");

    const seventh = await engine.authorize(ctx("c_p5", { params: { channel: "email", template_id: "T", language: "en", slots: {} } }));
    expect(seventh.decision.outcome).toBe("block");
    expect(seventh.decision.reason).toMatch(/global contact cap 6\/7d/);
  });

  it("does not spend budget on a blocked action", async () => {
    const { clock, engine, cases } = fixture(new Date("2026-09-02T17:11:00Z"));
    await seed("c_p6", clock, cases);
    await engine.authorize(ctx("c_p6"));
    expect(await engine.usage("cu_1", "whatsapp", 7)).toBe(0);
  });

  it("blocks contact to an opted-out customer", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p7", clock, cases);
    const { decision } = await engine.authorize(ctx("c_p7", { optedOut: true }));
    expect(decision.outcome).toBe("block");
    expect(decision.ruleId).toBe(RULES.OPTED_OUT);
  });

  it("blocks past the per-case retry cap", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p8", clock, cases);
    const { decision } = await engine.authorize(ctx("c_p8", { attemptNo: 4 }));
    expect(decision.outcome).toBe("block");
    expect(decision.ruleId).toBe(RULES.RETRY_CAP);
  });

  it("requires approval above the amount threshold instead of executing", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p9", clock, cases);
    const { decision, token } = await engine.authorize(ctx("c_p9", { amountPaise: 2_000_000 }));
    expect(decision.outcome).toBe("require_approval");
    expect(decision.ruleId).toBe(RULES.AMOUNT_APPROVAL);
    expect(token).toBeUndefined();
  });

  it("refuses to evaluate a forbidden action at all", async () => {
    const { clock, engine, cases } = fixture();
    await seed("c_p10", clock, cases);
    await expect(engine.authorize(ctx("c_p10", { actionId: "charge_retry" }))).rejects.toThrow(
      /forbidden by the library/,
    );
  });

  it("counts blocks per rule for the policy screen", async () => {
    const { clock, engine, cases } = fixture(new Date("2026-09-02T17:11:00Z"));
    await seed("c_p11", clock, cases);
    await engine.authorize(ctx("c_p11"));
    await engine.authorize(ctx("c_p11"));
    expect((await engine.blockCountsByRule())[RULES.QUIET_HOURS]).toBe(2);
  });
});

describe("capability tokens", () => {
  it("verifies a well-formed token", () => {
    const { minter } = fixture();
    const params = { channel: "sms", template_id: "T" };
    const token = minter.mint({
      caseId: "c_1", obligationId: "ob_1", actionId: "send_approved_template",
      paramsHash: hashParams(params), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    expect(() => minter.verify(token, { actionId: "send_approved_template", params })).not.toThrow();
  });

  it("rejects a tampered signature", () => {
    const { minter } = fixture();
    const params = {};
    const token = minter.mint({
      caseId: "c_1", obligationId: "ob_1", actionId: "wait",
      paramsHash: hashParams(params), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    const forged = { ...token, amountCapPaise: 9_999_999 };
    expect(() => minter.verify(forged, { actionId: "wait", params })).toThrow(TokenRejectedError);
  });

  it("rejects a token minted with a different key", () => {
    const { clock } = fixture();
    const attacker = new CapabilityMinter(Buffer.from("some-other-key"), clock);
    const real = new CapabilityMinter(KEY, clock);
    const params = {};
    const token = attacker.mint({
      caseId: "c_1", obligationId: "ob_1", actionId: "wait",
      paramsHash: hashParams(params), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    expect(() => real.verify(token, { actionId: "wait", params })).toThrow(/bad_signature/);
  });

  it("rejects a call whose action does not match the token", () => {
    const { minter } = fixture();
    const params = {};
    const token = minter.mint({
      caseId: "c_1", obligationId: "ob_1", actionId: "wait",
      paramsHash: hashParams(params), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    expect(() => minter.verify(token, { actionId: "create_payment_link", params })).toThrow(
      /action_mismatch/,
    );
  });

  it("rejects params swapped after minting", () => {
    const { minter } = fixture();
    const token = minter.mint({
      caseId: "c_1", obligationId: "ob_1", actionId: "send_approved_template",
      paramsHash: hashParams({ channel: "sms" }), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    expect(() =>
      minter.verify(token, { actionId: "send_approved_template", params: { channel: "whatsapp" } }),
    ).toThrow(/params_mismatch/);
  });

  it("rejects an amount above the cap", () => {
    const { minter } = fixture();
    const params = { amount: 300_000, currency: "INR" };
    const token = minter.mint({
      caseId: "c_1", obligationId: "ob_1", actionId: "create_payment_link",
      paramsHash: hashParams(params), attemptNo: 0, amountCapPaise: 300_000,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    expect(() =>
      minter.verify(token, { actionId: "create_payment_link", params, amountPaise: 420_000 }),
    ).toThrow(/amount_exceeds_cap/);
    expect(() =>
      minter.verify(token, { actionId: "create_payment_link", params, amountPaise: 300_000 }),
    ).not.toThrow();
  });

  it("expires", () => {
    const { clock, minter } = fixture();
    const params = {};
    const token = minter.mint({
      caseId: "c_1", obligationId: "ob_1", actionId: "wait",
      paramsHash: hashParams(params), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    clock.advance(120_001);
    expect(() => minter.verify(token, { actionId: "wait", params })).toThrow(/expired/);
  });

  it("rejects a replayed token on the second burn", async () => {
    const { clock, minter, burner, cases } = fixture();
    await seed("c_t1", clock, cases);
    const token = minter.mint({
      caseId: "c_t1", obligationId: "ob_c_t1", actionId: "wait",
      paramsHash: hashParams({}), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    await burner.burn(token);
    expect(await burner.isBurned(token.nonce)).toBe(true);
    await expect(burner.burn(token)).rejects.toThrow(TokenReplayError);
  });

  it("survives a concurrent double-spend with exactly one winner", async () => {
    const { clock, minter, burner, cases } = fixture();
    await seed("c_t2", clock, cases);
    const token = minter.mint({
      caseId: "c_t2", obligationId: "ob_c_t2", actionId: "wait",
      paramsHash: hashParams({}), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    const results = await Promise.allSettled([burner.burn(token), burner.burn(token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
