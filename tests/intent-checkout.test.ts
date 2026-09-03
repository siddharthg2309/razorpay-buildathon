import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { VirtualClock, days, hours } from "@rra/core";
import { Ledger, closePool, getPool } from "@rra/db";
import { CaseManager, CheckoutWatcher, IntentRouter, Reconciler, Verifier } from "@rra/engine";

const T0 = new Date("2026-09-02T09:00:00Z");

function fixture() {
  const clock = new VirtualClock(T0);
  const reconciler = new Reconciler(clock);
  const verifier = new Verifier(reconciler, new Ledger(clock), clock);
  return {
    clock, verifier, reconciler,
    router: new IntentRouter(verifier, clock),
    watcher: new CheckoutWatcher(clock),
    cases: new CaseManager(clock),
    ledger: new Ledger(clock),
  };
}

async function seed(caseId: string, clock: VirtualClock, cases: CaseManager, domain = "overdue_invoice" as const) {
  await getPool().query(`INSERT INTO merchants (id,name,policy_version) VALUES ('m_1','A','v7') ON CONFLICT DO NOTHING`);
  await getPool().query(`INSERT INTO customers (id,merchant_id) VALUES ('cu_1','m_1') ON CONFLICT DO NOTHING`);
  await cases.openOrAttach({
    caseId, merchantId: "m_1", customerId: "cu_1",
    obligationId: `ob_${caseId}`, externalRef: `ext_${caseId}`,
    domain, amountPaise: 420_000, dueAt: clock.now(), holdout: false,
  });
  return `ob_${caseId}`;
}

const caseState = async (id: string) =>
  (await getPool().query<{ state: string }>("SELECT state FROM cases WHERE id = $1", [id])).rows[0]?.state;

beforeEach(async () => {
  await getPool().query(
    `TRUNCATE promises_to_pay, checkout_sessions, attribution_runs, incident_members, incidents,
              settlements, action_attempts, token_burns, capability_tokens, policy_decisions,
              contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks,
              case_revisions, case_events, evidence, ledger, cases, obligations, customers,
              merchants CASCADE`,
  );
});
afterAll(async () => { await closePool(); });

describe("intent router", () => {
  it("records a promise to pay as evidence, never as recovered money", async () => {
    const f = fixture();
    const ob = await seed("c_p1", f.clock, f.cases);
    const out = await f.router.route("will_pay", {
      caseId: "c_p1", obligationId: ob, amountPaise: 420_000,
      promisedFor: new Date(T0.getTime() + days(5)),
    });

    expect(out.action).toBe("record_promise");
    // The whole point: a promise does not move the case toward recovery.
    expect(await caseState("c_p1")).not.toBe("RECOVERED");
    const { rows } = await getPool().query<{ state: string }>(
      "SELECT state FROM promises_to_pay WHERE case_id = 'c_p1'",
    );
    expect(rows[0]?.state).toBe("open");

    const entry = (await f.ledger.read("c_p1")).find((e) => e.eventType === "promise_recorded");
    expect(entry?.payload["note"]).toMatch(/not recovered money/);
  });

  it("marks a promise kept only when money actually arrived", async () => {
    const f = fixture();
    const ob = await seed("c_p2", f.clock, f.cases);
    await f.router.route("will_pay", {
      caseId: "c_p2", obligationId: ob, amountPaise: 420_000,
      promisedFor: new Date(T0.getTime() + days(2)),
    });

    await f.reconciler.record({
      id: "s_p2", merchantId: "m_1", amountPaise: 420_000, source: "natural", reference: "ext_c_p2",
    });
    f.clock.advance(days(3));
    expect(await f.router.reconcilePromises()).toEqual({ kept: 1, broken: 0 });
  });

  it("marks a promise broken when the date passes with no money", async () => {
    const f = fixture();
    const ob = await seed("c_p3", f.clock, f.cases);
    await f.router.route("will_pay", {
      caseId: "c_p3", obligationId: ob, amountPaise: 420_000,
      promisedFor: new Date(T0.getTime() + days(2)),
    });
    f.clock.advance(days(3));
    expect(await f.router.reconcilePromises()).toEqual({ kept: 0, broken: 1 });
    expect(await f.router.openPromises("c_p3")).toBe(0);
  });

  it("closes the case on a dispute and on an opt-out", async () => {
    const f = fixture();
    const a = await seed("c_p4", f.clock, f.cases);
    const b = await seed("c_p5", f.clock, f.cases);
    await f.router.route("dispute", { caseId: "c_p4", obligationId: a, amountPaise: 1 });
    await f.router.route("opt_out", { caseId: "c_p5", obligationId: b, amountPaise: 1 });
    expect(await caseState("c_p4")).toBe("DISPUTED");
    expect(await caseState("c_p5")).toBe("OPTED_OUT");
  });

  it("turns a missing PO into an approved information request", async () => {
    const f = fixture();
    const ob = await seed("c_p6", f.clock, f.cases);
    const out = await f.router.route("missing_po", { caseId: "c_p6", obligationId: ob, amountPaise: 420_000 });
    expect(out).toEqual({ action: "request_information", field: "purchase_order", templateId: "EM_PO_REQUEST" });
    // Collection pauses on a named field rather than continuing to chase.
    expect(await caseState("c_p6")).not.toBe("RECOVERED");
  });

  it("cannot be made to act by a crafted message — every branch is one a human wrote", async () => {
    const f = fixture();
    const ob = await seed("c_p7", f.clock, f.cases);
    // Whatever the text said, the interpreter only ever yields an enum, and
    // "unknown" is the safe branch.
    const out = await f.router.route("unknown", { caseId: "c_p7", obligationId: ob, amountPaise: 1 });
    expect(out.action).toBe("continue");
    expect(await caseState("c_p7")).toBe("DETECTED");
  });
});

describe("checkout inactivity threshold", () => {
  it("does not treat a briefly paused session as abandoned", async () => {
    const f = fixture();
    await seed("c_seed", f.clock, f.cases);
    await f.watcher.touch({
      sessionId: "sess_1", merchantId: "m_1", customerId: "cu_1",
      externalRef: "cart_1", amountPaise: 250_000, stage: "payment_method",
    });
    f.clock.advance(5 * 60_000);
    expect(await f.watcher.abandoned()).toHaveLength(0);
  });

  it("converts a session idle past the threshold", async () => {
    const f = fixture();
    await seed("c_seed", f.clock, f.cases);
    await f.watcher.touch({
      sessionId: "sess_2", merchantId: "m_1", customerId: "cu_1",
      externalRef: "cart_2", amountPaise: 250_000, stage: "payment_method",
    });
    f.clock.advance(21 * 60_000);
    const abandoned = await f.watcher.abandoned();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.lastStage).toBe("payment_method");
    expect(abandoned[0]?.idleMs).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it("resets the clock when the customer comes back", async () => {
    const f = fixture();
    await seed("c_seed", f.clock, f.cases);
    await f.watcher.touch({
      sessionId: "sess_3", merchantId: "m_1", customerId: "cu_1",
      externalRef: "cart_3", amountPaise: 250_000, stage: "address",
    });
    f.clock.advance(15 * 60_000);
    await f.watcher.touch({
      sessionId: "sess_3", merchantId: "m_1", customerId: "cu_1",
      externalRef: "cart_3", amountPaise: 250_000, stage: "payment_method",
    });
    f.clock.advance(15 * 60_000);
    expect(await f.watcher.abandoned()).toHaveLength(0);
  });

  it("ignores a completed checkout", async () => {
    const f = fixture();
    await seed("c_seed", f.clock, f.cases);
    await f.watcher.touch({
      sessionId: "sess_4", merchantId: "m_1", customerId: "cu_1",
      externalRef: "cart_4", amountPaise: 250_000, stage: "payment_method",
    });
    await f.watcher.complete("m_1", "cart_4");
    f.clock.advance(hours(2));
    expect(await f.watcher.abandoned()).toHaveLength(0);
  });

  it("leaves a session alone when its payment failed and opened its own case", async () => {
    const f = fixture();
    // A payment failure on this order already created the obligation.
    await seed("c_pay", f.clock, f.cases, "payment_failure");
    await f.watcher.touch({
      sessionId: "sess_5", merchantId: "m_1", customerId: "cu_1",
      externalRef: "ext_c_pay", amountPaise: 420_000, stage: "payment_method",
    });
    f.clock.advance(hours(1));
    // Sending generic cart messaging alongside payment recovery is the conflict
    // the brief calls out, so this session is not converted.
    expect(await f.watcher.abandoned()).toHaveLength(0);
  });

  it("does not convert the same session twice", async () => {
    const f = fixture();
    await seed("c_seed", f.clock, f.cases);
    await f.watcher.touch({
      sessionId: "sess_6", merchantId: "m_1", customerId: "cu_1",
      externalRef: "cart_6", amountPaise: 250_000, stage: "review",
    });
    f.clock.advance(hours(1));
    expect(await f.watcher.abandoned()).toHaveLength(1);
    await f.watcher.markConverted("sess_6", "c_seed");
    expect(await f.watcher.abandoned()).toHaveLength(0);
  });
});
