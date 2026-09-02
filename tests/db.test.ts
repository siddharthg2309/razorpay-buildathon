import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { VirtualClock, days, type CaseEvent } from "@rra/core";
import { CaseEventStore, Ledger, closePool, getPool } from "@rra/db";

const clock = new VirtualClock(new Date("2026-09-02T09:00:00Z"));
const events = new CaseEventStore(clock);
const ledger = new Ledger(clock);

async function seedCase(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO merchants (id, name, policy_version) VALUES ('m_1','Acme','v7')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO customers (id, merchant_id) VALUES ('cu_1','m_1') ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO obligations (id, merchant_id, customer_id, type, amount_paise, due_at, external_ref, state)
     VALUES ($1,'m_1','cu_1','subscription_renewal',420000,$2,$1,'due')`,
    [`ob_${id}`, clock.now()],
  );
  await pool.query(
    `INSERT INTO cases (id, obligation_id, domain, state, holdout_flag, opened_at)
     VALUES ($1,$2,'subscription_renewal','DETECTED',false,$3)`,
    [id, `ob_${id}`, clock.now()],
  );
}

beforeEach(async () => {
  const pool = getPool();
  await pool.query("TRUNCATE case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE");
});

afterAll(async () => {
  await closePool();
});

describe("ledger", () => {
  it("writes and reads back an entry", async () => {
    await seedCase("c_led");
    await ledger.append({
      caseId: "c_led",
      actor: "policy_engine",
      eventType: "policy_allow",
      payload: { ruleId: "R-114" },
      policyVersion: "v7",
    });
    const rows = await ledger.read("c_led");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("policy_allow");
    expect(rows[0]?.payload).toEqual({ ruleId: "R-114" });
    expect(rows[0]?.policyVersion).toBe("v7");
    expect(rows[0]?.ts.toISOString()).toBe("2026-09-02T09:00:00.000Z");
  });

  it("stamps entries from the injected clock, not wall time", async () => {
    await seedCase("c_time");
    const local = new VirtualClock(new Date("2026-09-02T09:00:00Z"));
    const l = new Ledger(local);
    await l.append({ caseId: "c_time", actor: "t", eventType: "first" });
    local.advance(days(14));
    await l.append({ caseId: "c_time", actor: "t", eventType: "second" });
    const rows = await l.read("c_time");
    expect(rows[1]!.ts.getTime() - rows[0]!.ts.getTime()).toBe(days(14));
  });
});

describe("case event store", () => {
  it("appends an event and persists the reduced revision", async () => {
    await seedCase("c_1");
    const { revision } = await events.append(
      "c_1",
      { type: "case_opened", domain: "subscription_renewal", holdout: false },
      "test",
    );
    expect(revision.revision).toBe(1);
    expect(revision.state).toBe("DETECTED");

    const { rows } = await getPool().query<{ state: string; next_seq: string }>(
      "SELECT state, next_seq FROM cases WHERE id = 'c_1'",
    );
    expect(rows[0]?.state).toBe("DETECTED");
    expect(Number(rows[0]?.next_seq)).toBe(1);
  });

  it("replays the log to exactly the stored revision", async () => {
    await seedCase("c_2");
    const log: CaseEvent[] = [
      { type: "case_opened", domain: "subscription_renewal", holdout: false },
      { type: "evidence_added", kind: "decline_code", evidenceId: "ev_1" },
      { type: "diagnosis_started", tier: 1 },
      { type: "plan_proposed", planVersion: 1 },
      { type: "approval_granted", approver: "policy" },
      { type: "action_executed", actionId: "send_approved_template", attemptNo: 1 },
    ];
    let last;
    for (const e of log) last = (await events.append("c_2", e, "test")).revision;

    const replayed = await events.replay("c_2");
    expect(replayed).toEqual(last);
    expect(replayed.state).toBe("OBSERVING");
    expect(replayed.attemptCount).toBe(1);
  });

  it("allocates seq under the case row lock, so concurrent appends do not collide", async () => {
    await seedCase("c_3");
    await events.append("c_3", { type: "case_opened", domain: "payment_failure", holdout: false }, "t");

    // Ten concurrent writers on one case. Without SELECT ... FOR UPDATE these
    // race on UNIQUE(case_id, seq) and most of them fail.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        events.append("c_3", { type: "evidence_added", kind: "payment_attempt", evidenceId: `ev_${i}` }, "t"),
      ),
    );

    const stored = await events.readAll("c_3");
    expect(stored).toHaveLength(11);
    expect(stored.map((s) => s.seq)).toEqual([...Array(11).keys()]);
    expect((await events.replay("c_3")).reducedThroughSeq).toBe(10);
  });

  it("records a terminal reason and closes the case", async () => {
    await seedCase("c_4");
    await events.append("c_4", { type: "case_opened", domain: "payment_failure", holdout: false }, "t");
    await events.append("c_4", { type: "terminal_reached", state: "RECOVERED", reason: "captured" }, "t");

    const { rows } = await getPool().query<{ state: string; terminal_reason: string; closed_at: Date }>(
      "SELECT state, terminal_reason, closed_at FROM cases WHERE id = 'c_4'",
    );
    expect(rows[0]?.state).toBe("RECOVERED");
    expect(rows[0]?.terminal_reason).toBe("captured");
    expect(rows[0]?.closed_at).not.toBeNull();
  });

  it("rolls back the whole append when the transition is illegal", async () => {
    await seedCase("c_5");
    await events.append("c_5", { type: "case_opened", domain: "payment_failure", holdout: false }, "t");
    await events.append("c_5", { type: "terminal_reached", state: "OPTED_OUT", reason: "unsubscribed" }, "t");

    await expect(
      events.append("c_5", { type: "diagnosis_started", tier: 1 }, "t"),
    ).rejects.toThrow(/illegal case transition/);

    // The rejected event left no trace: seq did not advance and no row landed.
    const stored = await events.readAll("c_5");
    expect(stored).toHaveLength(2);
    const { rows } = await getPool().query<{ next_seq: string }>(
      "SELECT next_seq FROM cases WHERE id = 'c_5'",
    );
    expect(Number(rows[0]?.next_seq)).toBe(2);
  });
});
