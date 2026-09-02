import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { VirtualClock, days } from "@rra/core";
import { CaseEventStore, Ledger, closePool, getPool } from "@rra/db";
import { CaseManager, Reconciler, Scheduler, Verifier } from "@rra/engine";

const T0 = new Date("2026-09-02T09:00:00Z");

function fixture() {
  const clock = new VirtualClock(T0);
  const reconciler = new Reconciler(clock);
  const ledger = new Ledger(clock);
  return {
    clock, reconciler, ledger,
    verifier: new Verifier(reconciler, ledger, clock),
    scheduler: new Scheduler(clock),
    cases: new CaseManager(clock),
    events: new CaseEventStore(clock),
  };
}

async function seed(caseId: string, clock: VirtualClock, cases: CaseManager, amountPaise = 420_000) {
  await getPool().query(`INSERT INTO merchants (id,name,policy_version) VALUES ('m_1','A','v7') ON CONFLICT DO NOTHING`);
  await getPool().query(`INSERT INTO customers (id,merchant_id) VALUES ('cu_1','m_1') ON CONFLICT DO NOTHING`);
  await cases.openOrAttach({
    caseId, merchantId: "m_1", customerId: "cu_1",
    obligationId: `ob_${caseId}`, externalRef: `ext_${caseId}`,
    domain: "subscription_renewal", amountPaise, dueAt: clock.now(), holdout: false,
  });
  return `ob_${caseId}`;
}

const caseState = async (id: string) =>
  (await getPool().query<{ state: string }>("SELECT state FROM cases WHERE id = $1", [id])).rows[0]?.state;

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE settlements, action_attempts, token_burns, capability_tokens, policy_decisions, contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE",
  );
});
afterAll(async () => { await closePool(); });

describe("reconciler", () => {
  it("matches on the idempotency key of an action we initiated", async () => {
    const f = fixture();
    const ob = await seed("c_v1", f.clock, f.cases);
    await getPool().query(
      `INSERT INTO action_attempts (id, case_id, obligation_id, action_id, attempt_no, idem_key, surface, state, request, sent_at)
       VALUES ('a1','c_v1',$1,'create_payment_link',0,'idem_abc','simulated','succeeded','{}',$2)`,
      [ob, f.clock.now()],
    );
    const m = await f.reconciler.record({
      id: "s1", merchantId: "m_1", amountPaise: 420_000, source: "webhook", idemKey: "idem_abc",
    });
    expect(m.matchedBy).toBe("idem_key");
    expect(m.obligationId).toBe(ob);
  });

  it("matches a Smart Collect transfer by virtual account, with no action behind it", async () => {
    const f = fixture();
    const ob = await seed("c_v2", f.clock, f.cases);
    await getPool().query("UPDATE obligations SET virtual_account = 'VA_ACME_88' WHERE id = $1", [ob]);

    const m = await f.reconciler.record({
      id: "s2", merchantId: "m_1", amountPaise: 420_000, source: "smart_collect", virtualAccount: "VA_ACME_88",
    });
    expect(m.matchedBy).toBe("virtual_account");
    expect(m.obligationId).toBe(ob);
  });

  it("leaves an unrecognised transfer unmatched rather than guessing", async () => {
    const f = fixture();
    await seed("c_v3", f.clock, f.cases);
    const m = await f.reconciler.record({
      id: "s3", merchantId: "m_1", amountPaise: 999, source: "smart_collect", virtualAccount: "VA_UNKNOWN",
    });
    expect(m.matchedBy).toBe("unmatched");
    expect(m.obligationId).toBeNull();
    expect(await f.reconciler.unmatched()).toHaveLength(1);
  });

  it("prefers the idempotency key over a weaker reference match", async () => {
    const f = fixture();
    const ob = await seed("c_v4", f.clock, f.cases);
    await getPool().query(
      `INSERT INTO action_attempts (id, case_id, obligation_id, action_id, attempt_no, idem_key, surface, state, request, sent_at)
       VALUES ('a2','c_v4',$1,'create_payment_link',0,'idem_xyz','simulated','succeeded','{}',$2)`,
      [ob, f.clock.now()],
    );
    const m = await f.reconciler.record({
      id: "s4", merchantId: "m_1", amountPaise: 420_000, source: "webhook",
      idemKey: "idem_xyz", reference: "ext_c_v4",
    });
    expect(m.matchedBy).toBe("idem_key");
  });
});

describe("verifier", () => {
  it("moves a fully settled case to RECOVERED and clears its schedule", async () => {
    const f = fixture();
    const ob = await seed("c_v5", f.clock, f.cases);
    for (const d of [days(3), days(7), days(14)]) {
      await f.scheduler.schedule({
        caseId: "c_v5", obligationId: ob,
        fireAt: new Date(T0.getTime() + d),
        actionRef: { actionId: "send_approved_template", params: {}, attemptNo: 1 },
      });
    }
    expect(await f.scheduler.pendingCount("c_v5")).toBe(3);

    const out = await f.verifier.onSettlement({
      id: "s5", merchantId: "m_1", amountPaise: 420_000, source: "webhook", reference: "ext_c_v5",
    });

    expect(out.kind).toBe("recovered");
    expect(await caseState("c_v5")).toBe("RECOVERED");
    expect(await f.scheduler.pendingCount("c_v5")).toBe(0);

    // Advance well past every scheduled step: nothing may fire.
    f.clock.advance(days(30));
    expect(await f.scheduler.tick("w1")).toHaveLength(0);
  });

  it("does not recover on a partial settlement", async () => {
    const f = fixture();
    await seed("c_v6", f.clock, f.cases, 420_000);
    const out = await f.verifier.onSettlement({
      id: "s6", merchantId: "m_1", amountPaise: 100_000, source: "webhook", reference: "ext_c_v6",
    });
    expect(out.kind).toBe("partial");
    expect(await caseState("c_v6")).not.toBe("RECOVERED");
  });

  it("recovers once instalments add up to the full amount", async () => {
    const f = fixture();
    await seed("c_v7", f.clock, f.cases, 420_000);
    await f.verifier.onSettlement({ id: "s7a", merchantId: "m_1", amountPaise: 200_000, source: "webhook", reference: "ext_c_v7" });
    expect(await caseState("c_v7")).not.toBe("RECOVERED");
    const out = await f.verifier.onSettlement({ id: "s7b", merchantId: "m_1", amountPaise: 220_000, source: "webhook", reference: "ext_c_v7" });
    expect(out.kind).toBe("recovered");
    expect(await caseState("c_v7")).toBe("RECOVERED");
  });

  it("treats a delivered message as no recovery at all", async () => {
    const f = fixture();
    await seed("c_v8", f.clock, f.cases);
    await f.verifier.onOutcome({ caseId: "c_v8", result: "succeeded", detail: { delivered: true } });
    expect(await caseState("c_v8")).not.toBe("RECOVERED");
  });

  it("closes on opt-out and on dispute", async () => {
    const f = fixture();
    await seed("c_v9", f.clock, f.cases);
    await seed("c_v10", f.clock, f.cases);
    await f.verifier.onOutcome({ caseId: "c_v9", result: "opted_out" });
    await f.verifier.onOutcome({ caseId: "c_v10", result: "disputed" });
    expect(await caseState("c_v9")).toBe("OPTED_OUT");
    expect(await caseState("c_v10")).toBe("DISPUTED");
  });

  it("ignores money that matches no obligation", async () => {
    const f = fixture();
    await seed("c_v11", f.clock, f.cases);
    const out = await f.verifier.onSettlement({
      id: "s11", merchantId: "m_1", amountPaise: 50_000, source: "smart_collect", virtualAccount: "VA_NOPE",
    });
    expect(out.kind).toBe("unmatched");
    expect(await caseState("c_v11")).toBe("DETECTED");
  });

  it("marks an exhausted case unrecoverable and stops its schedule", async () => {
    const f = fixture();
    const ob = await seed("c_v12", f.clock, f.cases);
    await f.scheduler.schedule({
      caseId: "c_v12", obligationId: ob, fireAt: new Date(T0.getTime() + days(3)),
      actionRef: { actionId: "wait", params: {}, attemptNo: 1 },
    });
    await f.verifier.exhaust("c_v12", "retry_ceiling_reached");
    expect(await caseState("c_v12")).toBe("UNRECOVERABLE");
    expect(await f.scheduler.pendingCount("c_v12")).toBe(0);
  });

  it("writes a ledger trail for the recovery", async () => {
    const f = fixture();
    await seed("c_v13", f.clock, f.cases);
    await f.verifier.onSettlement({
      id: "s13", merchantId: "m_1", amountPaise: 420_000, source: "webhook", reference: "ext_c_v13",
    });
    const entries = await f.ledger.read("c_v13");
    const recovered = entries.find((e) => e.eventType === "recovered");
    expect(recovered?.payload).toMatchObject({ matchedBy: "reference", settlementId: "s13" });
  });
});
