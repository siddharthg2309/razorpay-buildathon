import { describe, expect, it } from "vitest";
import {
  CaseEventOrderError,
  IllegalTransitionError,
  initialRevision,
  isCaseClosed,
  reduce,
  reduceAll,
  type CaseEvent,
  type StoredCaseEvent,
} from "@rra/core";

const log = (...events: CaseEvent[]): StoredCaseEvent[] =>
  events.map((event, seq) => ({
    caseId: "c_1",
    seq,
    event,
    source: "test",
    occurredAt: new Date(seq * 1000),
  }));

describe("event reducer", () => {
  it("is deterministic — same log, same revision", () => {
    const events = log(
      { type: "case_opened", domain: "subscription_renewal", holdout: false },
      { type: "evidence_added", kind: "decline_code", evidenceId: "ev_1" },
      { type: "diagnosis_started", tier: 1 },
      { type: "plan_proposed", planVersion: 1 },
    );
    expect(reduceAll("c_1", events)).toEqual(reduceAll("c_1", events));
  });

  it("tracks state, tier, attempts and plan version", () => {
    const r = reduceAll(
      "c_1",
      log(
        { type: "case_opened", domain: "payment_failure", holdout: true },
        { type: "diagnosis_started", tier: 1 },
        { type: "plan_proposed", planVersion: 1 },
        { type: "approval_granted", approver: "policy" },
        { type: "action_executed", actionId: "send_approved_template", attemptNo: 1 },
      ),
    );
    expect(r.state).toBe("OBSERVING");
    expect(r.tier).toBe(1);
    expect(r.holdout).toBe(true);
    expect(r.attemptCount).toBe(1);
    expect(r.planVersion).toBe(1);
    expect(r.reducedThroughSeq).toBe(4);
    expect(r.revision).toBe(5);
  });

  it("accumulates evidence kinds and reports only what changed this revision", () => {
    const events = log(
      { type: "case_opened", domain: "payment_failure", holdout: false },
      { type: "evidence_added", kind: "decline_code", evidenceId: "ev_1" },
      { type: "evidence_added", kind: "mandate_state", evidenceId: "ev_2" },
    );
    const r = reduceAll("c_1", events);
    expect(r.evidenceKinds).toEqual(["decline_code", "mandate_state"]);
    // Only the last event's kind — this is what the work router consumes.
    expect(r.changedKinds).toEqual(["mandate_state"]);
  });

  it("does not duplicate a repeated evidence kind", () => {
    const r = reduceAll(
      "c_1",
      log(
        { type: "case_opened", domain: "payment_failure", holdout: false },
        { type: "evidence_added", kind: "customer_reply", evidenceId: "ev_1" },
        { type: "evidence_added", kind: "customer_reply", evidenceId: "ev_2" },
      ),
    );
    expect(r.evidenceKinds).toEqual(["customer_reply"]);
  });

  it("holds state for evidence and observations", () => {
    const r = reduceAll(
      "c_1",
      log(
        { type: "case_opened", domain: "payment_failure", holdout: false },
        { type: "diagnosis_started", tier: 0 },
        { type: "evidence_added", kind: "payment_attempt", evidenceId: "ev_1" },
      ),
    );
    expect(r.state).toBe("DIAGNOSING");
  });

  it("suppresses to an incident and releases back", () => {
    const r = reduceAll(
      "c_1",
      log(
        { type: "case_opened", domain: "payment_failure", holdout: false },
        { type: "incident_attached", incidentId: "inc_1" },
      ),
    );
    expect(r.state).toBe("SUPPRESSED_BY_INCIDENT");
    expect(r.incidentId).toBe("inc_1");
    expect(isCaseClosed(r)).toBe(false);

    const released = reduce(r, {
      caseId: "c_1",
      seq: 2,
      event: { type: "incident_released", incidentId: "inc_1" },
      source: "test",
      occurredAt: new Date(),
    });
    expect(released.state).toBe("SCHEDULED");
    expect(released.incidentId).toBeNull();
  });

  it("expires an unapproved case to stopped_human rather than executing", () => {
    const r = reduceAll(
      "c_1",
      log(
        { type: "case_opened", domain: "overdue_invoice", holdout: false },
        { type: "diagnosis_started", tier: 2 },
        { type: "plan_proposed", planVersion: 1 },
        { type: "approval_required", ruleId: "R-301" },
        { type: "approval_expired" },
      ),
    );
    expect(r.state).toBe("STOPPED_HUMAN");
    expect(isCaseClosed(r)).toBe(true);
  });

  it("rejects out-of-order events", () => {
    const r = initialRevision("c_1");
    expect(() =>
      reduce(r, {
        caseId: "c_1",
        seq: 5,
        event: { type: "case_opened", domain: "payment_failure", holdout: false },
        source: "test",
        occurredAt: new Date(),
      }),
    ).toThrow(CaseEventOrderError);
  });

  it("rejects an event that would drive an illegal transition", () => {
    const r = reduceAll(
      "c_1",
      log(
        { type: "case_opened", domain: "payment_failure", holdout: false },
        { type: "terminal_reached", state: "RECOVERED", reason: "captured" },
      ),
    );
    expect(() =>
      reduce(r, {
        caseId: "c_1",
        seq: 2,
        event: { type: "diagnosis_started", tier: 1 },
        source: "test",
        occurredAt: new Date(),
      }),
    ).toThrow(IllegalTransitionError);
  });
});
