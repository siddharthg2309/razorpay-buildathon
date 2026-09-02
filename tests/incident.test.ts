import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  VirtualClock, benjaminiHochberg, days, normalCdf, twoProportionZTest, wilsonInterval,
} from "@rra/core";
import { closePool, getPool } from "@rra/db";
import {
  AnomalyDetector, CaseManager, IncidentManager, ReleaseController, Scheduler,
  isAncestor, proposeReroute, segmentLabel, type SegmentObservation,
} from "@rra/engine";

const T0 = new Date("2026-09-02T09:00:00Z");

/** A healthy segment: 90% approval against a 90% baseline. */
const healthy = (over: Partial<SegmentObservation> = {}): SegmentObservation => ({
  segment: { gateway: "A", method: "card", issuer: "HDFC" },
  attempts: 400, approvals: 360, baselineAttempts: 4000, baselineApprovals: 3600, ...over,
});

/** A degraded segment: 40% approval against the same 90% baseline. */
const degraded = (over: Partial<SegmentObservation> = {}): SegmentObservation =>
  healthy({ approvals: 160, ...over });

beforeEach(async () => {
  await getPool().query(
    "TRUNCATE incident_members, incidents, segment_windows, segment_baselines, settlements, action_attempts, token_burns, capability_tokens, policy_decisions, contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger, cases, obligations, customers, merchants CASCADE",
  );
});
afterAll(async () => { await closePool(); });

describe("statistics", () => {
  it("gives a sane normal CDF", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it("detects a real drop and ignores a matching rate", () => {
    const drop = twoProportionZTest(160, 400, 3600, 4000);
    expect(drop.z).toBeLessThan(-10);
    expect(drop.pValue).toBeLessThan(0.001);

    const same = twoProportionZTest(360, 400, 3600, 4000);
    expect(same.pValue).toBeGreaterThan(0.4);
  });

  it("does not flag an improvement as an incident", () => {
    const better = twoProportionZTest(390, 400, 3600, 4000);
    expect(better.z).toBeGreaterThan(0);
  });

  it("holds the false-discovery rate across many tests", () => {
    // 100 pure-noise p-values, uniformly distributed. Uncorrected, ~5 would
    // pass at alpha 0.05; BH should pass essentially none.
    const noise = Array.from({ length: 100 }, (_, i) => ({ p: (i + 1) / 100 }));
    expect(benjaminiHochberg(noise, (x) => x.p, 0.05).length).toBeLessThanOrEqual(1);

    const withReal = [{ p: 0.0001 }, { p: 0.0002 }, ...noise];
    expect(benjaminiHochberg(withReal, (x) => x.p, 0.05).length).toBeGreaterThanOrEqual(2);
  });

  it("widens the Wilson interval at small n", () => {
    const [lo1, hi1] = wilsonInterval(8, 10);
    const [lo2, hi2] = wilsonInterval(800, 1000);
    expect(hi1 - lo1).toBeGreaterThan(hi2 - lo2);
  });
});

describe("segment hierarchy", () => {
  it("labels segments stably", () => {
    expect(segmentLabel({ gateway: "A", issuer: "HDFC" })).toBe("gateway=A&issuer=HDFC");
    expect(segmentLabel({})).toBe("all");
  });

  it("recognises a coarser segment as an ancestor", () => {
    expect(isAncestor({ gateway: "A" }, { gateway: "A", issuer: "HDFC" })).toBe(true);
    expect(isAncestor({ gateway: "A", issuer: "HDFC" }, { gateway: "A" })).toBe(false);
    expect(isAncestor({ gateway: "B" }, { gateway: "A", issuer: "HDFC" })).toBe(false);
  });
});

describe("anomaly detector", () => {
  const detector = () => new AnomalyDetector(new VirtualClock(T0));

  it("stays silent on a healthy segment", () => {
    const d = detector();
    expect(d.evaluate([healthy()])).toHaveLength(0);
    expect(d.evaluate([healthy()])).toHaveLength(0);
  });

  it("refuses to test below the volume floor", () => {
    const d = detector();
    const tiny = degraded({ attempts: 10, approvals: 2 });
    expect(d.evaluate([tiny])).toHaveLength(0);
    expect(d.evaluate([tiny])).toHaveLength(0);
    expect(d.dwellCount(segmentLabel(tiny.segment))).toBe(0);
  });

  it("waits for dwell before opening, so a single blip does not fire", () => {
    const d = detector();
    expect(d.evaluate([degraded()])).toHaveLength(0); // window 1
    const fired = d.evaluate([degraded()]);           // window 2
    expect(fired).toHaveLength(1);
    expect(fired[0]?.test.z).toBeLessThan(0);
  });

  it("resets dwell when the segment recovers mid-way", () => {
    const d = detector();
    d.evaluate([degraded()]);
    d.evaluate([healthy()]);
    expect(d.evaluate([degraded()])).toHaveLength(0);
  });

  it("opens exactly one incident when a parent explains its children", () => {
    const d = detector();
    // The gateway is down, so every child segment under it also looks bad.
    const family: SegmentObservation[] = [
      degraded({ segment: { gateway: "A" } }),
      degraded({ segment: { gateway: "A", issuer: "HDFC" } }),
      degraded({ segment: { gateway: "A", issuer: "ICICI" } }),
      degraded({ segment: { gateway: "A", issuer: "SBI" } }),
      degraded({ segment: { gateway: "A", issuer: "AXIS" } }),
    ];
    d.evaluate(family);
    const fired = d.evaluate(family);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("gateway=A");
  });

  it("does not fire on a mix shift that leaves every segment healthy", () => {
    const d = detector();
    // Aggregate rate falls because volume moved to a lower-approving issuer,
    // but each segment matches its own baseline.
    const mix: SegmentObservation[] = [
      healthy({ segment: { issuer: "HDFC" }, attempts: 100, approvals: 90, baselineAttempts: 4000, baselineApprovals: 3600 }),
      healthy({ segment: { issuer: "SMALLBANK" }, attempts: 900, approvals: 450, baselineAttempts: 1000, baselineApprovals: 500 }),
    ];
    d.evaluate(mix);
    expect(d.evaluate(mix)).toHaveLength(0);
  });

  it("closes after a run of healthy windows", () => {
    const d = detector();
    const label = segmentLabel(healthy().segment);
    d.evaluate([degraded()]);
    d.evaluate([degraded()]);
    expect(d.shouldClose(label)).toBe(false);
    for (let i = 0; i < 3; i++) d.evaluate([healthy()]);
    expect(d.shouldClose(label)).toBe(true);
  });
});

describe("incident lifecycle", () => {
  async function seedCases(n: number, clock: VirtualClock): Promise<string[]> {
    await getPool().query(`INSERT INTO merchants (id,name,policy_version) VALUES ('m_1','A','v7') ON CONFLICT DO NOTHING`);
    await getPool().query(`INSERT INTO customers (id,merchant_id) VALUES ('cu_1','m_1') ON CONFLICT DO NOTHING`);
    const cases = new CaseManager(clock);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `c_i${String(i).padStart(3, "0")}`;
      await cases.openOrAttach({
        caseId: id, merchantId: "m_1", customerId: "cu_1",
        obligationId: `ob_${id}`, externalRef: `ext_${id}`,
        domain: "payment_failure", amountPaise: 420_000, dueAt: clock.now(), holdout: false,
      });
      ids.push(id);
    }
    return ids;
  }

  it("parks affected cases and cancels their schedules, opening one incident", async () => {
    const clock = new VirtualClock(T0);
    const incidents = new IncidentManager(clock);
    const scheduler = new Scheduler(clock);
    const ids = await seedCases(47, clock);

    for (const id of ids) {
      await scheduler.schedule({
        caseId: id, obligationId: `ob_${id}`, fireAt: new Date(T0.getTime() + days(1)),
        actionRef: { actionId: "create_payment_link", params: {}, attemptNo: 1 },
      });
    }

    const d = new AnomalyDetector(clock);
    d.evaluate([degraded()]);
    const fired = d.evaluate([degraded()]);
    const incidentId = await incidents.open(fired[0]!, "detector");

    expect(await incidents.attachAndSuppress(incidentId, ids)).toBe(47);
    expect(await incidents.openIncidentCount()).toBe(1);
    expect(await incidents.parkedCases(incidentId)).toHaveLength(47);

    // Nothing may fire while parked.
    clock.advance(days(2));
    expect(await scheduler.tick("w1")).toHaveLength(0);

    const { rows } = await getPool().query<{ state: string }>(
      "SELECT DISTINCT state FROM cases WHERE id = ANY($1::text[])", [ids],
    );
    expect(rows.map((r) => r.state)).toEqual(["SUPPRESSED_BY_INCIDENT"]);
  });

  it("is idempotent — a second detection does not open a second incident", async () => {
    const clock = new VirtualClock(T0);
    const incidents = new IncidentManager(clock);
    const d = new AnomalyDetector(clock);
    d.evaluate([degraded()]);
    const fired = d.evaluate([degraded()]);
    const first = await incidents.open(fired[0]!, "detector");
    const second = await incidents.open(fired[0]!, "detector");
    expect(second).toBe(first);
    expect(await incidents.openIncidentCount()).toBe(1);
  });

  it("opens from a Razorpay downtime webhook too", async () => {
    const incidents = new IncidentManager(new VirtualClock(T0));
    const id = await incidents.openFromDowntime({ gateway: "A", method: "card" });
    const rec = await incidents.get(id);
    expect(rec?.label).toBe("gateway=A&method=card");
    const { rows } = await getPool().query<{ detected_by: string }>(
      "SELECT detected_by FROM incidents WHERE id = $1", [id],
    );
    expect(rows[0]?.detected_by).toBe("razorpay_downtime_webhook");
  });

  it("ramps release 5 -> 15 -> 40 -> 100 without releasing everything at once", async () => {
    const clock = new VirtualClock(T0);
    const incidents = new IncidentManager(clock);
    const controller = new ReleaseController(incidents, clock);
    const ids = await seedCases(100, clock);
    const incidentId = await incidents.openFromDowntime({ gateway: "A" });
    await incidents.attachAndSuppress(incidentId, ids);

    const good = { observedRate: 0.9, baselineRate: 0.9 };
    const first = await controller.step(incidentId, good);
    expect(first.action).toBe("released");
    // 5% of 100 with up to +/-20% jitter.
    expect(first.releasedNow).toBeGreaterThanOrEqual(4);
    expect(first.releasedNow).toBeLessThanOrEqual(6);
    expect(first.stillParked).toBeGreaterThan(90);

    const second = await controller.step(incidentId, good);
    expect(second.releasedNow).toBeGreaterThan(first.releasedNow);
  });

  it("re-parks rather than pressing on when the rate drops mid-ramp", async () => {
    const clock = new VirtualClock(T0);
    const incidents = new IncidentManager(clock);
    const controller = new ReleaseController(incidents, clock);
    const ids = await seedCases(50, clock);
    const incidentId = await incidents.openFromDowntime({ gateway: "A" });
    await incidents.attachAndSuppress(incidentId, ids);

    const released = await controller.step(incidentId, { observedRate: 0.9, baselineRate: 0.9 });
    expect(released.action).toBe("released");
    const parkedAfterRelease = (await incidents.parkedCases(incidentId)).length;

    // The gateway degrades again during the ramp.
    const broke = await controller.step(incidentId, { observedRate: 0.4, baselineRate: 0.9 });
    expect(broke.action).toBe("reparked");
    expect(broke.reason).toMatch(/below/);
    expect((await incidents.parkedCases(incidentId)).length).toBeGreaterThan(parkedAfterRelease);
    expect((await incidents.get(incidentId))?.releaseStage).toBe(0);
  });

  it("finishes and closes once every case is released", async () => {
    const clock = new VirtualClock(T0);
    const incidents = new IncidentManager(clock);
    const controller = new ReleaseController(incidents, clock);
    const ids = await seedCases(20, clock);
    const incidentId = await incidents.openFromDowntime({ gateway: "A" });
    await incidents.attachAndSuppress(incidentId, ids);

    const good = { observedRate: 0.92, baselineRate: 0.9 };
    let last;
    for (let i = 0; i < 12; i++) {
      last = await controller.step(incidentId, good);
      if (last.action === "completed") break;
    }
    expect(last?.action).toBe("completed");
    expect((await incidents.get(incidentId))?.state).toBe("closed");
    expect(await incidents.parkedCases(incidentId)).toHaveLength(0);
  });

  it("stores the RCA against the incident", async () => {
    const incidents = new IncidentManager(new VirtualClock(T0));
    const id = await incidents.openFromDowntime({ gateway: "A" });
    await incidents.recordRca(id, { narrative: "issuer-side timeout on gateway A", proposed: "hold and observe" });
    const { rows } = await getPool().query<{ rca: { narrative: string } }>(
      "SELECT rca FROM incidents WHERE id = $1", [id],
    );
    expect(rows[0]?.rca.narrative).toMatch(/issuer-side timeout/);
  });
});

describe("routing proposal", () => {
  it("stays a simulated, approval-only proposal with a TTL", () => {
    const p = proposeReroute("inc_1", "A", "B");
    expect(p.surface).toBe("simulated");
    expect(p.requiresApproval).toBe(true);
    expect(p.canaryPercent).toBe(5);
    expect(p.ttlHours).toBeGreaterThan(0);
  });
});
