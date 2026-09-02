import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ROLE_IDS, ROLE_REGISTRY, VirtualClock, rolesDependingOn, type RoleId } from "@rra/core";
import { CaseEventStore, closePool, getPool } from "@rra/db";
import { Blackboard, CaseManager, WorkRouter } from "@rra/engine";

const T0 = new Date("2026-09-02T09:00:00Z");

function fixture() {
  const clock = new VirtualClock(T0);
  const blackboard = new Blackboard(clock);
  return {
    clock,
    blackboard,
    router: new WorkRouter(blackboard),
    cases: new CaseManager(clock),
    events: new CaseEventStore(clock),
  };
}

async function seed(caseId: string, clock: VirtualClock, cases: CaseManager) {
  await getPool().query(`INSERT INTO merchants (id, name, policy_version) VALUES ('m_1','A','v7') ON CONFLICT DO NOTHING`);
  await getPool().query(`INSERT INTO customers (id, merchant_id) VALUES ('cu_1','m_1') ON CONFLICT DO NOTHING`);
  await cases.openOrAttach({
    caseId, merchantId: "m_1", customerId: "cu_1",
    obligationId: `ob_${caseId}`, externalRef: `ext_${caseId}`,
    domain: "subscription_renewal", amountPaise: 420_000, dueAt: clock.now(), holdout: false,
  });
}

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE claims, agent_runs, scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE",
  );
});
afterAll(async () => { await closePool(); });

describe("role registry", () => {
  it("gives only the reply-reading roles a dependency on customer_reply", () => {
    expect(rolesDependingOn(["customer_reply"]).sort()).toEqual(["communication", "customer_context"]);
  });

  it("keeps recovery_economics free of any provider call", () => {
    expect(ROLE_REGISTRY.recovery_economics.mayUseProvider).toBe(false);
    expect(ROLE_REGISTRY.recovery_economics.callBudget).toBe(0);
  });

  it("gives no role a connector in its tool scope", () => {
    const connectorish = /connector|charge|payment_link|execute|token/i;
    for (const id of ROLE_IDS) {
      for (const tool of ROLE_REGISTRY[id].toolScope) {
        expect(tool).not.toMatch(connectorish);
      }
    }
  });

  it("bounds every role with a timeout and a call budget", () => {
    for (const id of ROLE_IDS) {
      expect(ROLE_REGISTRY[id].timeoutMs).toBeGreaterThan(0);
      expect(ROLE_REGISTRY[id].callBudget).toBeGreaterThanOrEqual(0);
      expect(ROLE_REGISTRY[id].dependsOn.length).toBeGreaterThan(0);
    }
  });
});

describe("work router", () => {
  const allRoles = [...ROLE_IDS] as RoleId[];

  it("runs every role when the case has no claims yet", () => {
    const { router } = fixture();
    const d = router.plan(["decline_code"], []);
    expect(d.rerun.sort()).toEqual([...allRoles].sort());
    expect(d.reused).toEqual([]);
  });

  it("reruns only context and communication on an inbound reply", () => {
    const { router } = fixture();
    const d = router.plan(["customer_reply"], allRoles);
    expect(d.rerun.sort()).toEqual(["communication", "customer_context"]);
    expect(d.reused.sort()).toEqual([
      "incident_intelligence",
      "payment_diagnosis",
      "recovery_economics",
    ]);
  });

  it("reruns diagnosis and economics on a new decline code, not communication", () => {
    const { router } = fixture();
    const d = router.plan(["decline_code"], allRoles);
    expect(d.rerun.sort()).toEqual(["payment_diagnosis", "recovery_economics"]);
    expect(d.reused).toContain("communication");
  });

  it("reruns nothing when the changed evidence affects no role's dependencies", () => {
    const { router } = fixture();
    const d = router.plan([], allRoles);
    expect(d.rerun).toEqual([]);
    expect(d.reused.sort()).toEqual([...allRoles].sort());
  });

  it("touches only incident intelligence on segment metrics", () => {
    const { router } = fixture();
    expect(router.plan(["segment_metrics"], allRoles).rerun).toEqual(["incident_intelligence"]);
  });

  it("invalidates exactly the stale claims and leaves the rest live", async () => {
    const { clock, blackboard, router, cases, events } = fixture();
    await seed("c_r1", clock, cases);

    for (const role of allRoles) {
      await blackboard.writeClaim({
        id: `cl_${role}`, caseId: "c_r1", revision: 1, role,
        confidence: 0.9, payload: { note: role }, evidenceRefs: ["ev_seed"],
      });
    }
    expect(await blackboard.liveClaims("c_r1")).toHaveLength(5);

    const { revision } = await events.append(
      "c_r1",
      { type: "evidence_added", kind: "customer_reply", evidenceId: "ev_reply" },
      "webhook",
    );
    const decision = await router.route(revision);

    expect(decision.rerun.sort()).toEqual(["communication", "customer_context"]);
    const stillLive = (await blackboard.liveClaims("c_r1")).map((c) => c.role).sort();
    expect(stillLive).toEqual(["incident_intelligence", "payment_diagnosis", "recovery_economics"]);
  });

  it("keeps a superseded claim in the trail rather than deleting it", async () => {
    const { clock, blackboard, cases } = fixture();
    await seed("c_r2", clock, cases);

    await blackboard.writeClaim({
      id: "cl_1", caseId: "c_r2", revision: 1, role: "payment_diagnosis",
      confidence: 0.6, payload: { cause: "guess" },
    });
    await blackboard.writeClaim({
      id: "cl_2", caseId: "c_r2", revision: 2, role: "payment_diagnosis",
      confidence: 0.94, payload: { cause: "mandate_cap_breach" },
    });

    const live = await blackboard.liveClaims("c_r2");
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe("cl_2");

    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM claims WHERE case_id = 'c_r2'",
    );
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it("records an agent run with its provider metadata", async () => {
    const { clock, blackboard, cases } = fixture();
    await seed("c_r3", clock, cases);
    await blackboard.recordRun({
      id: "run_1", caseId: "c_r3", revision: 1, role: "payment_diagnosis",
      status: "ok", inputHash: "abc123", provider: "openai", model: "gpt-5.6-terra",
      latencyMs: 812, costPaise: 4,
    });
    const { rows } = await getPool().query<{ provider: string; model: string; latency_ms: number }>(
      "SELECT provider, model, latency_ms FROM agent_runs WHERE id = 'run_1'",
    );
    expect(rows[0]?.provider).toBe("openai");
    expect(rows[0]?.model).toBe("gpt-5.6-terra");
    expect(rows[0]?.latency_ms).toBe(812);
  });

  it("scopes evidence reads by kind so a role sees only its dependencies", async () => {
    const { clock, blackboard, cases } = fixture();
    await seed("c_r4", clock, cases);
    await blackboard.addEvidence({ id: "ev_a", caseId: "c_r4", kind: "decline_code", payload: { code: "X" }, source: "webhook" });
    await blackboard.addEvidence({ id: "ev_b", caseId: "c_r4", kind: "customer_reply", payload: { text: "will pay" }, source: "whatsapp" });

    const scoped = await blackboard.evidenceFor("c_r4", ROLE_REGISTRY.payment_diagnosis.dependsOn);
    expect(scoped.map((e) => e.id)).toEqual(["ev_a"]);
    expect(await blackboard.evidenceFor("c_r4")).toHaveLength(2);
  });
});
