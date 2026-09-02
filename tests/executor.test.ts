import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { CapabilityMinter, RULES, VirtualClock, hashParams, loadConfig, loadPolicy } from "@rra/core";
import { closePool, getPool } from "@rra/db";
import { RazorpayTestAdapter, SimulatedPSP, UnsupportedCapabilityError } from "@rra/connectors";
import {
  CaseManager,
  Executor,
  ObligationLease,
  PolicyEngine,
  ScheduleActionNotExecutableError,
  TokenBurner,
  TokenReplayError,
  idempotencyKey,
} from "@rra/engine";

const policy = loadPolicy(join(process.cwd(), "policies/acme-subscriptions.yaml"));
const config = loadConfig();
const KEY = Buffer.from("test-signing-key");
const DAYTIME = new Date("2026-09-02T08:30:00Z");

function fixture(adapter?: SimulatedPSP | RazorpayTestAdapter) {
  const clock = new VirtualClock(DAYTIME);
  const minter = new CapabilityMinter(KEY, clock);
  const burner = new TokenBurner(clock);
  const lease = new ObligationLease(clock);
  const psp = adapter ?? new SimulatedPSP(clock);
  return {
    clock, minter, burner, lease, psp,
    engine: new PolicyEngine(policy, config.library, minter, clock),
    executor: new Executor(psp, config.library, minter, burner, lease, clock),
    cases: new CaseManager(clock),
  };
}

async function seed(caseId: string, clock: VirtualClock, cases: CaseManager) {
  await getPool().query(`INSERT INTO merchants (id,name,policy_version) VALUES ('m_1','A','v7') ON CONFLICT DO NOTHING`);
  await getPool().query(`INSERT INTO customers (id,merchant_id) VALUES ('cu_1','m_1') ON CONFLICT DO NOTHING`);
  await cases.openOrAttach({
    caseId, merchantId: "m_1", customerId: "cu_1",
    obligationId: `ob_${caseId}`, externalRef: `ext_${caseId}`,
    domain: "payment_failure", amountPaise: 420_000, dueAt: clock.now(), holdout: false,
  });
}

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE action_attempts, token_burns, capability_tokens, policy_decisions, contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE",
  );
});
afterAll(async () => { await closePool(); });

const LINK_PARAMS = { amount: 420_000, currency: "INR", expiry_hours: 72 };

describe("idempotency key", () => {
  it("is stable for the same inputs and moves with each of them", () => {
    const base = idempotencyKey("c_1", "create_payment_link", 1, LINK_PARAMS);
    expect(base).toBe(idempotencyKey("c_1", "create_payment_link", 1, LINK_PARAMS));
    expect(base).not.toBe(idempotencyKey("c_2", "create_payment_link", 1, LINK_PARAMS));
    expect(base).not.toBe(idempotencyKey("c_1", "create_payment_link", 2, LINK_PARAMS));
    expect(base).not.toBe(idempotencyKey("c_1", "create_payment_link", 1, { ...LINK_PARAMS, amount: 1 }));
  });

  it("ignores key order in params", () => {
    expect(idempotencyKey("c_1", "a", 0, { x: 1, y: 2 })).toBe(
      idempotencyKey("c_1", "a", 0, { y: 2, x: 1 }),
    );
  });
});

describe("executor", () => {
  async function authorized(caseId: string, f: ReturnType<typeof fixture>) {
    const { decision, token } = await f.engine.authorize({
      caseId, obligationId: `ob_${caseId}`, customerId: "cu_1",
      rail: "card", actionId: "create_payment_link", params: LINK_PARAMS,
      attemptNo: 0, amountPaise: 420_000,
    });
    expect(decision.outcome).toBe("allow");
    return token!;
  }

  it("executes an authorised action and records the attempt", async () => {
    const f = fixture();
    await seed("c_x1", f.clock, f.cases);
    const token = await authorized("c_x1", f);

    const out = await f.executor.execute({
      caseId: "c_x1", obligationId: "ob_c_x1", customerId: "cu_1",
      actionId: "create_payment_link", attemptNo: 0, params: LINK_PARAMS,
      token, amountPaise: 420_000,
    });
    expect(out.result.ok).toBe(true);
    expect(out.surface).toBe("simulated");

    const attempts = await f.executor.attemptsFor("c_x1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe("succeeded");
    expect(attempts[0]?.surface).toBe("simulated");
  });

  it("refuses a call carrying no valid token", async () => {
    const f = fixture();
    await seed("c_x2", f.clock, f.cases);
    const token = await authorized("c_x2", f);
    const forged = { ...token, amountCapPaise: 99_999_999 };

    await expect(
      f.executor.execute({
        caseId: "c_x2", obligationId: "ob_c_x2", customerId: "cu_1",
        actionId: "create_payment_link", attemptNo: 0, params: LINK_PARAMS,
        token: forged, amountPaise: 99_999_999,
      }),
    ).rejects.toThrow(/bad_signature/);
    expect(await f.executor.attemptsFor("c_x2")).toHaveLength(0);
  });

  it("refuses a replayed token before the call, not after", async () => {
    const f = fixture();
    await seed("c_x3", f.clock, f.cases);
    const token = await authorized("c_x3", f);
    const req = {
      caseId: "c_x3", obligationId: "ob_c_x3", customerId: "cu_1",
      actionId: "create_payment_link", attemptNo: 0, params: LINK_PARAMS,
      token, amountPaise: 420_000,
    };
    await f.executor.execute(req);
    await expect(f.executor.execute(req)).rejects.toThrow(TokenReplayError);
    // Exactly one attempt: the replay never reached the connector.
    expect(await f.executor.attemptsFor("c_x3")).toHaveLength(1);
  });

  it("rejects an unsupported capability before execution", async () => {
    const razorpay = new RazorpayTestAdapter({ keyId: "k", keySecret: "s", webhookSecret: "w" });
    const f = fixture(razorpay);
    await seed("c_x4", f.clock, f.cases);

    const { token } = await f.engine.authorize({
      caseId: "c_x4", obligationId: "ob_c_x4", customerId: "cu_1",
      rail: "card", actionId: "send_approved_template",
      params: { channel: "whatsapp", template_id: "T", language: "en", slots: {} },
      attemptNo: 0,
    });

    await expect(
      f.executor.execute({
        caseId: "c_x4", obligationId: "ob_c_x4", customerId: "cu_1",
        actionId: "send_approved_template", attemptNo: 0,
        params: { channel: "whatsapp", template_id: "T", language: "en", slots: {} },
        token: token!,
      }),
    ).rejects.toThrow(UnsupportedCapabilityError);

    // Nothing was attempted and the token was not burned — it can still be used
    // against an adapter that does support the capability.
    expect(await f.executor.attemptsFor("c_x4")).toHaveLength(0);
    expect(await f.burner.isBurned(token!.nonce)).toBe(false);
  });

  it("refuses to execute a schedule action through the connector", async () => {
    const f = fixture();
    await seed("c_x5", f.clock, f.cases);
    const token = f.minter.mint({
      caseId: "c_x5", obligationId: "ob_c_x5", actionId: "wait",
      paramsHash: hashParams({ delay_hours: 48, reason: "x" }), attemptNo: 0,
      amountCapPaise: null, policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    await expect(
      f.executor.execute({
        caseId: "c_x5", obligationId: "ob_c_x5", customerId: "cu_1",
        actionId: "wait", attemptNo: 0, params: { delay_hours: 48, reason: "x" }, token,
      }),
    ).rejects.toThrow(ScheduleActionNotExecutableError);
  });

  it("holds the obligation lease for the duration of the call", async () => {
    const f = fixture();
    await seed("c_x6", f.clock, f.cases);
    const token = await authorized("c_x6", f);

    // Someone else holds the obligation — admission must not proceed.
    await f.lease.acquire("ob_c_x6", "other_worker");
    await expect(
      f.executor.execute({
        caseId: "c_x6", obligationId: "ob_c_x6", customerId: "cu_1",
        actionId: "create_payment_link", attemptNo: 0, params: LINK_PARAMS,
        token, amountPaise: 420_000,
      }),
    ).rejects.toThrow(/leased by other_worker/);
    expect(await f.executor.attemptsFor("c_x6")).toHaveLength(0);
  });

  it("releases the lease after a successful call", async () => {
    const f = fixture();
    await seed("c_x7", f.clock, f.cases);
    const token = await authorized("c_x7", f);
    await f.executor.execute({
      caseId: "c_x7", obligationId: "ob_c_x7", customerId: "cu_1",
      actionId: "create_payment_link", attemptNo: 0, params: LINK_PARAMS,
      token, amountPaise: 420_000,
    });
    expect(await f.lease.tryAcquire("ob_c_x7", "someone_else")).toBe(true);
  });
});

describe("crash reconciliation", () => {
  it("resolves an in_flight attempt by asking the PSP, never by re-issuing", async () => {
    const f = fixture();
    await seed("c_r1", f.clock, f.cases);

    // Simulate a process killed between the call and the response: the row is
    // in_flight, and the provider did in fact see it.
    const idemKey = idempotencyKey("c_r1", "create_payment_link", 0, LINK_PARAMS);
    await getPool().query(
      `INSERT INTO action_attempts (id, case_id, obligation_id, action_id, attempt_no, idem_key, surface, state, request, sent_at)
       VALUES ($1,'c_r1','ob_c_r1','create_payment_link',0,$1,'simulated','in_flight','{}',$2)`,
      [idemKey, f.clock.now()],
    );
    f.psp.seedSettled(idemKey, { found: true, captured: true, amountPaise: 420_000, reference: "sim_link_x" });

    const out = await f.executor.reconcile();
    expect(out).toEqual({ reconciled: 1, stillUnknown: 0 });

    const attempts = await f.executor.attemptsFor("c_r1");
    expect(attempts).toHaveLength(1); // no second charge
    expect(attempts[0]?.state).toBe("reconciled");
  });

  it("leaves an attempt the provider never saw as unknown rather than assuming", async () => {
    const f = fixture();
    await seed("c_r2", f.clock, f.cases);
    const idemKey = idempotencyKey("c_r2", "create_payment_link", 0, LINK_PARAMS);
    await getPool().query(
      `INSERT INTO action_attempts (id, case_id, obligation_id, action_id, attempt_no, idem_key, surface, state, request, sent_at)
       VALUES ($1,'c_r2','ob_c_r2','create_payment_link',0,$1,'simulated','in_flight','{}',$2)`,
      [idemKey, f.clock.now()],
    );
    expect(await f.executor.reconcile()).toEqual({ reconciled: 0, stillUnknown: 1 });
    expect((await f.executor.attemptsFor("c_r2"))[0]?.state).toBe("in_flight");
  });

  it("cannot write two attempts for one idempotency key", async () => {
    const f = fixture();
    await seed("c_r3", f.clock, f.cases);
    const idemKey = idempotencyKey("c_r3", "create_payment_link", 0, LINK_PARAMS);
    const insert = () =>
      getPool().query(
        `INSERT INTO action_attempts (id, case_id, obligation_id, action_id, attempt_no, idem_key, surface, state, request, sent_at)
         VALUES ($1,'c_r3','ob_c_r3','create_payment_link',0,$1,'simulated','in_flight','{}',$2)`,
        [idemKey, f.clock.now()],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });
});

describe("adapter surfaces", () => {
  it("declares only what Razorpay test mode genuinely supports", () => {
    const razorpay = new RazorpayTestAdapter({ keyId: "k", keySecret: "s", webhookSecret: "w" });
    expect([...razorpay.capabilities()].sort()).toEqual(["createPaymentLink", "fetchPaymentStatus"]);
    expect(razorpay.surface).toBe("live");
    expect(() => razorpay.sendApprovedTemplate()).toThrow(UnsupportedCapabilityError);
    expect(() => razorpay.requestPaymentMethodUpdate()).toThrow(UnsupportedCapabilityError);
  });

  it("gives the simulator the full library and labels it simulated", () => {
    const sim = new SimulatedPSP(new VirtualClock(DAYTIME));
    expect(sim.surface).toBe("simulated");
    expect(sim.capabilities().size).toBe(6);
  });

  it("samples identically for the same seed", async () => {
    const call = { caseId: "c", obligationId: "o", customerId: "cu_1", params: LINK_PARAMS, idemKey: "k" };
    const token = new CapabilityMinter(KEY, new VirtualClock(DAYTIME)).mint({
      caseId: "c", obligationId: "o", actionId: "create_payment_link",
      paramsHash: hashParams(LINK_PARAMS), attemptNo: 0, amountCapPaise: null,
      policyVersion: "v7", ruleId: RULES.ALLOWED,
    });
    const a = new SimulatedPSP(new VirtualClock(DAYTIME), new Map(), 42);
    const b = new SimulatedPSP(new VirtualClock(DAYTIME), new Map(), 42);
    const ra = await a.createPaymentLink(call, token);
    const rb = await b.createPaymentLink(call, token);
    expect(ra.detail).toEqual(rb.detail);
  });
});
