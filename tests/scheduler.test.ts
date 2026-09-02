import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { VirtualClock, days, hours } from "@rra/core";
import { CaseEventStore, closePool, getPool } from "@rra/db";
import { CaseManager, ObligationLease, LeaseUnavailableError, Scheduler } from "@rra/engine";

const T0 = new Date("2026-09-02T09:00:00Z");

function fixture() {
  const clock = new VirtualClock(T0);
  return {
    clock,
    scheduler: new Scheduler(clock),
    lease: new ObligationLease(clock),
    cases: new CaseManager(clock),
    events: new CaseEventStore(clock),
  };
}

async function seed(caseId: string, clock: VirtualClock, cases: CaseManager): Promise<string> {
  await getPool().query(
    `INSERT INTO merchants (id, name, policy_version) VALUES ('m_1','Acme','v7') ON CONFLICT DO NOTHING`,
  );
  await getPool().query(
    `INSERT INTO customers (id, merchant_id) VALUES ('cu_1','m_1') ON CONFLICT DO NOTHING`,
  );
  await cases.openOrAttach({
    caseId,
    merchantId: "m_1",
    customerId: "cu_1",
    obligationId: `ob_${caseId}`,
    externalRef: `ext_${caseId}`,
    domain: "subscription_renewal",
    amountPaise: 420_000,
    dueAt: clock.now(),
    holdout: false,
  });
  return `ob_${caseId}`;
}

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE",
  );
});
afterAll(async () => {
  await closePool();
});

describe("durable scheduler", () => {
  it("fires exactly once, and only after its virtual due time", async () => {
    const { clock, scheduler, cases } = fixture();
    const ob = await seed("c_1", clock, cases);

    await scheduler.schedule({
      caseId: "c_1",
      obligationId: ob,
      fireAt: new Date(T0.getTime() + days(3)),
      actionRef: { actionId: "create_payment_link", params: {}, attemptNo: 1 },
    });

    expect(await scheduler.tick("w1")).toHaveLength(0);

    clock.advance(days(3) - 1);
    expect(await scheduler.tick("w1")).toHaveLength(0);

    clock.advance(1);
    const due = await scheduler.tick("w1");
    expect(due).toHaveLength(1);
    expect(due[0]?.actionRef.actionId).toBe("create_payment_link");

    // Already leased — a second tick must not hand it out again.
    expect(await scheduler.tick("w2")).toHaveLength(0);
    await scheduler.complete(due[0]!.id);
    clock.advance(days(1));
    expect(await scheduler.tick("w1")).toHaveLength(0);
  });

  it("splits the due set between concurrent workers instead of double-leasing", async () => {
    const { clock, scheduler, cases } = fixture();
    const ob = await seed("c_2", clock, cases);
    for (let i = 0; i < 12; i++) {
      await scheduler.schedule({
        caseId: "c_2",
        obligationId: ob,
        fireAt: new Date(T0.getTime() + hours(1)),
        actionRef: { actionId: "wait", params: { i }, attemptNo: 1 },
      });
    }
    clock.advance(hours(2));

    const [a, b, c] = await Promise.all([
      scheduler.tick("w1"),
      scheduler.tick("w2"),
      scheduler.tick("w3"),
    ]);
    const ids = [...a!, ...b!, ...c!].map((r) => r.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it("fires a whole dunning sequence in order under the virtual clock", async () => {
    const { clock, scheduler, cases } = fixture();
    const ob = await seed("c_3", clock, cases);
    for (const [n, delay] of [[1, hours(1)], [2, days(3)], [3, days(7)], [4, days(14)]] as const) {
      await scheduler.schedule({
        caseId: "c_3",
        obligationId: ob,
        fireAt: new Date(T0.getTime() + delay),
        actionRef: { actionId: "send_approved_template", params: {}, attemptNo: n },
      });
    }

    const fired: number[] = [];
    for (const step of [hours(1), days(3), days(7), days(14)]) {
      clock.advanceTo(new Date(T0.getTime() + step));
      const due = await scheduler.tick("w1");
      for (const row of due) {
        fired.push(row.actionRef.attemptNo);
        await scheduler.complete(row.id);
      }
    }
    expect(fired).toEqual([1, 2, 3, 4]);
  });

  it("reclaims a lease whose worker died", async () => {
    const { clock, scheduler, cases } = fixture();
    const ob = await seed("c_4", clock, cases);
    await scheduler.schedule({
      caseId: "c_4",
      obligationId: ob,
      fireAt: T0,
      actionRef: { actionId: "wait", params: {}, attemptNo: 1 },
    });

    const leased = await scheduler.tick("w_doomed");
    expect(leased).toHaveLength(1);
    expect(await scheduler.tick("w2")).toHaveLength(0);

    clock.advance(60_000); // past the lease
    expect(await scheduler.reclaimExpiredLeases()).toBe(1);

    const retried = await scheduler.tick("w2");
    expect(retried).toHaveLength(1);
    // Attempts accumulate across reclaims, so a row that keeps killing workers
    // is visible rather than silently looping.
    expect(retried[0]?.attempts).toBe(2);
  });
});

describe("cancel on terminal", () => {
  it("cancels every pending action in the same transaction as the terminal write", async () => {
    const { clock, scheduler, cases, events } = fixture();
    const ob = await seed("c_5", clock, cases);
    for (const delay of [days(3), days(7), days(14)]) {
      await scheduler.schedule({
        caseId: "c_5",
        obligationId: ob,
        fireAt: new Date(T0.getTime() + delay),
        actionRef: { actionId: "send_approved_template", params: {}, attemptNo: 1 },
      });
    }
    expect(await scheduler.pendingCount("c_5")).toBe(3);

    // The customer pays on their own. The rest of the sequence must vanish.
    await events.append("c_5", { type: "terminal_reached", state: "RECOVERED", reason: "captured" }, "verifier");

    expect(await scheduler.pendingCount("c_5")).toBe(0);
    clock.advance(days(30));
    expect(await scheduler.tick("w1")).toHaveLength(0);
  });

  it("leaves other cases' schedules untouched", async () => {
    const { clock, scheduler, cases, events } = fixture();
    const obA = await seed("c_6", clock, cases);
    const obB = await seed("c_7", clock, cases);
    await scheduler.schedule({ caseId: "c_6", obligationId: obA, fireAt: new Date(T0.getTime() + days(3)), actionRef: { actionId: "wait", params: {}, attemptNo: 1 } });
    await scheduler.schedule({ caseId: "c_7", obligationId: obB, fireAt: new Date(T0.getTime() + days(3)), actionRef: { actionId: "wait", params: {}, attemptNo: 1 } });

    await events.append("c_6", { type: "terminal_reached", state: "OPTED_OUT", reason: "unsubscribed" }, "t");

    expect(await scheduler.pendingCount("c_6")).toBe(0);
    expect(await scheduler.pendingCount("c_7")).toBe(1);
  });
});

describe("obligation lease", () => {
  it("admits one holder at a time", async () => {
    const { clock, lease, cases } = fixture();
    const ob = await seed("c_8", clock, cases);

    expect(await lease.tryAcquire(ob, "executor_a")).toBe(true);
    expect(await lease.tryAcquire(ob, "executor_b")).toBe(false);
    await expect(lease.acquire(ob, "executor_b")).rejects.toThrow(LeaseUnavailableError);

    await lease.release(ob, "executor_a");
    expect(await lease.tryAcquire(ob, "executor_b")).toBe(true);
  });

  it("is reentrant for the same holder and expires on time", async () => {
    const { clock, lease, cases } = fixture();
    const ob = await seed("c_9", clock, cases);

    expect(await lease.tryAcquire(ob, "executor_a")).toBe(true);
    expect(await lease.tryAcquire(ob, "executor_a")).toBe(true);

    clock.advance(61_000);
    expect(await lease.tryAcquire(ob, "executor_b")).toBe(true);
  });

  it("releases even when the guarded work throws", async () => {
    const { clock, lease, cases } = fixture();
    const ob = await seed("c_10", clock, cases);
    await expect(
      lease.withLease(ob, "executor_a", async () => {
        throw new Error("connector blew up");
      }),
    ).rejects.toThrow("connector blew up");
    expect(await lease.tryAcquire(ob, "executor_b")).toBe(true);
  });
});

describe("obligation dedup", () => {
  it("attaches a second trigger to the live case instead of opening another", async () => {
    const { clock, cases } = fixture();
    await seed("c_11", clock, cases);

    // The abandonment timer fires for the same order.
    const second = await cases.openOrAttach({
      caseId: "c_12",
      merchantId: "m_1",
      customerId: "cu_1",
      obligationId: "ob_c_11",
      externalRef: "ext_c_11",
      domain: "checkout_abandonment",
      amountPaise: 420_000,
      dueAt: clock.now(),
      holdout: false,
    });

    expect(second.attached).toBe(true);
    expect(second.caseId).toBe("c_11");

    const { rows } = await getPool().query<{ n: string }>("SELECT count(*) AS n FROM cases");
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("opens a fresh case once the previous one closed", async () => {
    const { clock, cases, events } = fixture();
    await seed("c_13", clock, cases);
    await events.append("c_13", { type: "terminal_reached", state: "RECOVERED", reason: "captured" }, "t");

    const again = await cases.openOrAttach({
      caseId: "c_14",
      merchantId: "m_1",
      customerId: "cu_1",
      obligationId: "ob_c_13",
      externalRef: "ext_c_13",
      domain: "subscription_renewal",
      amountPaise: 420_000,
      dueAt: clock.now(),
      holdout: false,
    });
    expect(again.attached).toBe(false);
    expect(again.caseId).toBe("c_14");
  });
});
