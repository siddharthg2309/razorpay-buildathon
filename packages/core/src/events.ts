import type { CaseId, EvidenceKind, IncidentId, Tier } from "./types.js";
import { assertTransition, isTerminal, type CaseState, type TerminalState } from "./state-machine.js";

/**
 * The event log is the authoritative input. The reducer below is the sole
 * writer of case state: anything that wants to change a case emits an event.
 */
export type CaseEvent =
  | { type: "case_opened"; domain: string; holdout: boolean }
  | { type: "evidence_added"; kind: EvidenceKind; evidenceId: string }
  | { type: "diagnosis_started"; tier: Tier }
  | { type: "plan_proposed"; planVersion: number }
  | { type: "approval_required"; ruleId: string }
  | { type: "approval_granted"; approver: string }
  | { type: "approval_expired" }
  | { type: "action_executed"; actionId: string; attemptNo: number }
  | { type: "action_scheduled"; actionId: string; fireAt: string }
  | { type: "outcome_observed"; outcome: string }
  | { type: "incident_attached"; incidentId: IncidentId }
  | { type: "incident_released"; incidentId: IncidentId }
  | { type: "terminal_reached"; state: TerminalState; reason: string };

export type CaseEventType = CaseEvent["type"];

export interface StoredCaseEvent {
  caseId: CaseId;
  seq: number;
  event: CaseEvent;
  source: string;
  occurredAt: Date;
}

export interface CaseRevision {
  caseId: CaseId;
  revision: number;
  reducedThroughSeq: number;
  state: CaseState;
  tier: Tier;
  holdout: boolean;
  attemptCount: number;
  planVersion: number;
  incidentId: IncidentId | null;
  terminalReason: string | null;
  /** Evidence kinds present, in insertion order. Drives claim invalidation. */
  evidenceKinds: readonly EvidenceKind[];
  /** Kinds that arrived in *this* revision — exactly what the router reads. */
  changedKinds: readonly EvidenceKind[];
}

export class CaseEventOrderError extends Error {
  constructor(expected: number, got: number) {
    super(`case events must apply in order: expected seq ${expected}, got ${got}`);
    this.name = "CaseEventOrderError";
  }
}

export function initialRevision(caseId: CaseId): CaseRevision {
  return {
    caseId,
    revision: 0,
    reducedThroughSeq: -1,
    state: "DETECTED",
    tier: 0,
    holdout: false,
    attemptCount: 0,
    planVersion: 0,
    incidentId: null,
    terminalReason: null,
    evidenceKinds: [],
    changedKinds: [],
  };
}

/** Which state an event drives the case to, or null to hold the current state. */
function targetState(e: CaseEvent, current: CaseState): CaseState | null {
  switch (e.type) {
    case "case_opened":
      return "DETECTED";
    case "diagnosis_started":
      return "DIAGNOSING";
    case "plan_proposed":
      return "PLANNING";
    case "approval_required":
      return "AWAITING_APPROVAL";
    case "approval_granted":
      return "EXECUTING";
    case "approval_expired":
      return "STOPPED_HUMAN";
    case "action_executed":
      return "OBSERVING";
    case "action_scheduled":
      return "SCHEDULED";
    case "incident_attached":
      return "SUPPRESSED_BY_INCIDENT";
    case "incident_released":
      return "SCHEDULED";
    case "terminal_reached":
      return e.state;
    // Observing an outcome while executing means the execution finished — the
    // provider answered, whether it succeeded or not. Leaving the case in
    // EXECUTING makes a failed attempt indistinguishable from one still in
    // flight, and blocks every legal transition out of it.
    case "outcome_observed":
      return current === "EXECUTING" ? "OBSERVING" : current;

    // Evidence informs the case without moving it. The work router decides
    // whether it warrants re-diagnosis.
    case "evidence_added":
      return current;
  }
}

/**
 * The deterministic event reducer. Pure: same (revision, event) always yields
 * the same next revision, which is what makes replay a proof rather than a
 * re-run.
 */
export function reduce(prev: CaseRevision, stored: StoredCaseEvent): CaseRevision {
  const expected = prev.reducedThroughSeq + 1;
  if (stored.seq !== expected) throw new CaseEventOrderError(expected, stored.seq);

  const e = stored.event;
  const next = targetState(e, prev.state);
  if (next === null) throw new Error(`unhandled event type in reducer`);
  assertTransition(prev.state, next, e.type);

  const evidenceKinds =
    e.type === "evidence_added" && !prev.evidenceKinds.includes(e.kind)
      ? [...prev.evidenceKinds, e.kind]
      : prev.evidenceKinds;

  return {
    caseId: prev.caseId,
    revision: prev.revision + 1,
    reducedThroughSeq: stored.seq,
    state: next,
    tier: e.type === "diagnosis_started" ? e.tier : prev.tier,
    holdout: e.type === "case_opened" ? e.holdout : prev.holdout,
    attemptCount: e.type === "action_executed" ? prev.attemptCount + 1 : prev.attemptCount,
    planVersion: e.type === "plan_proposed" ? e.planVersion : prev.planVersion,
    incidentId:
      e.type === "incident_attached"
        ? e.incidentId
        : e.type === "incident_released"
          ? null
          : prev.incidentId,
    terminalReason: e.type === "terminal_reached" ? e.reason : prev.terminalReason,
    evidenceKinds,
    changedKinds: e.type === "evidence_added" ? [e.kind] : [],
  };
}

/** Fold a whole log. This is the replay verifier's primitive. */
export function reduceAll(caseId: CaseId, events: readonly StoredCaseEvent[]): CaseRevision {
  return events.reduce(reduce, initialRevision(caseId));
}

export const isCaseClosed = (r: CaseRevision): boolean => isTerminal(r.state);
