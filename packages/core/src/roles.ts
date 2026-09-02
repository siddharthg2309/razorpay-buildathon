import type { EvidenceKind } from "./types.js";

export const ROLE_IDS = [
  "payment_diagnosis",
  "customer_context",
  "incident_intelligence",
  "recovery_economics",
  "communication",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export interface RoleContract {
  role: RoleId;
  /**
   * The evidence kinds this role reads. Claim invalidation is derived from
   * this: when a revision brings evidence of kind K, exactly the roles
   * declaring K are rerun and every other claim is reused as-is.
   *
   * Getting this wrong is quiet in both directions — too narrow and a role
   * keeps a stale claim, too wide and the batch pays for reruns that change
   * nothing. It is asserted directly in tests.
   */
  dependsOn: readonly EvidenceKind[];
  /** Retrieval tools the role may call. Never includes a connector. */
  toolScope: readonly string[];
  /** Whether this role may reach an LLM provider at all. */
  mayUseProvider: boolean;
  timeoutMs: number;
  callBudget: number;
}

export const ROLE_REGISTRY: Readonly<Record<RoleId, RoleContract>> = {
  payment_diagnosis: {
    role: "payment_diagnosis",
    dependsOn: ["payment_attempt", "decline_code", "mandate_state"],
    toolScope: ["taxonomy_lookup", "attempt_history"],
    mayUseProvider: true,
    timeoutMs: 8000,
    callBudget: 1,
  },
  customer_context: {
    role: "customer_context",
    dependsOn: ["customer_profile", "customer_reply", "contact_history", "obligation_state"],
    toolScope: ["customer_lookup", "obligation_lookup", "contact_budget_read"],
    mayUseProvider: true,
    timeoutMs: 8000,
    callBudget: 1,
  },
  incident_intelligence: {
    role: "incident_intelligence",
    dependsOn: ["incident_membership", "segment_metrics"],
    toolScope: ["incident_index", "segment_baseline"],
    mayUseProvider: true,
    timeoutMs: 10_000,
    callBudget: 1,
  },
  recovery_economics: {
    role: "recovery_economics",
    dependsOn: ["payment_attempt", "decline_code", "obligation_state", "policy_snapshot"],
    toolScope: ["action_library", "policy_snapshot_read"],
    // Deterministic in P1: candidates come from the library and are scored by
    // expected value. No provider call at all.
    mayUseProvider: false,
    timeoutMs: 2000,
    callBudget: 0,
  },
  communication: {
    role: "communication",
    dependsOn: ["customer_profile", "customer_reply", "contact_history", "policy_snapshot"],
    toolScope: ["template_catalog"],
    mayUseProvider: true,
    timeoutMs: 6000,
    callBudget: 1,
  },
};

export const roleContract = (role: RoleId): RoleContract => ROLE_REGISTRY[role];

/** Roles that read at least one of the given evidence kinds. */
export function rolesDependingOn(kinds: readonly EvidenceKind[]): RoleId[] {
  const changed = new Set(kinds);
  return ROLE_IDS.filter((id) =>
    ROLE_REGISTRY[id].dependsOn.some((k) => changed.has(k)),
  );
}
