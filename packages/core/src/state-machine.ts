export const CASE_STATES = [
  "DETECTED",
  "DIAGNOSING",
  "PLANNING",
  "AWAITING_APPROVAL",
  "EXECUTING",
  "OBSERVING",
  "SCHEDULED",
  "SUPPRESSED_BY_INCIDENT",
  "RECOVERED",
  "UNRECOVERABLE",
  "CANCELLED",
  "DISPUTED",
  "OPTED_OUT",
  "STOPPED_HUMAN",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

/**
 * Terminal for the agent. SUPPRESSED_BY_INCIDENT is deliberately not here: the
 * incident owns resumption, so a suppressed case can still be released.
 */
export const TERMINAL_STATES = [
  "RECOVERED",
  "UNRECOVERABLE",
  "CANCELLED",
  "DISPUTED",
  "OPTED_OUT",
  "STOPPED_HUMAN",
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

const TERMINAL = new Set<CaseState>(TERMINAL_STATES);

export const isTerminal = (s: CaseState): s is TerminalState => TERMINAL.has(s);

/**
 * Any state may reach a terminal — a customer can opt out or dispute at any
 * point — so terminals are permitted from everywhere rather than enumerated
 * per source state.
 */
const LEGAL: Readonly<Record<CaseState, readonly CaseState[]>> = {
  DETECTED: ["DIAGNOSING", "SUPPRESSED_BY_INCIDENT"],
  DIAGNOSING: ["PLANNING", "SUPPRESSED_BY_INCIDENT"],
  PLANNING: ["AWAITING_APPROVAL", "EXECUTING", "SCHEDULED", "SUPPRESSED_BY_INCIDENT"],
  AWAITING_APPROVAL: ["EXECUTING", "SUPPRESSED_BY_INCIDENT"],
  EXECUTING: ["OBSERVING", "SUPPRESSED_BY_INCIDENT"],
  OBSERVING: ["DIAGNOSING", "SCHEDULED", "PLANNING", "SUPPRESSED_BY_INCIDENT"],
  SCHEDULED: ["DIAGNOSING", "EXECUTING", "SUPPRESSED_BY_INCIDENT"],
  SUPPRESSED_BY_INCIDENT: ["SCHEDULED", "DIAGNOSING"],
  RECOVERED: [],
  UNRECOVERABLE: [],
  CANCELLED: [],
  DISPUTED: [],
  OPTED_OUT: [],
  STOPPED_HUMAN: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: CaseState,
    readonly to: CaseState,
    readonly cause_: string,
  ) {
    super(`illegal case transition ${from} → ${to} (caused by ${cause_})`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  if (isTerminal(to)) return true;
  return LEGAL[from].includes(to);
}

/** Rejects illegal transitions loudly — a silent one corrupts the audit trail. */
export function assertTransition(from: CaseState, to: CaseState, because: string): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, because);
}
