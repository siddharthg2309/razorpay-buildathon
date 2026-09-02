import type { CaseRevision, EvidenceKind, RoleId } from "@rra/core";
import { ROLE_IDS, rolesDependingOn } from "@rra/core";
import type { Blackboard } from "./blackboard.js";

export interface RoutingDecision {
  /** Roles to (re)run for this revision. */
  rerun: readonly RoleId[];
  /** Roles whose existing claims stay valid and are reused as-is. */
  reused: readonly RoleId[];
  /** What drove the decision — recorded in the ledger. */
  changedKinds: readonly EvidenceKind[];
}

/**
 * Decides which specialists a revision actually requires.
 *
 * The alternative — rerunning every role on every event — is what makes naive
 * multi-agent systems unaffordable and unreplayable. Here a new revision
 * invalidates only the claims whose declared dependencies moved.
 */
export class WorkRouter {
  constructor(private readonly blackboard: Blackboard) {}

  /** Pure: what would rerun, given the changed kinds and the roles holding claims. */
  plan(changedKinds: readonly EvidenceKind[], rolesWithLiveClaims: readonly RoleId[]): RoutingDecision {
    const affected = new Set(rolesDependingOn(changedKinds));
    const live = new Set(rolesWithLiveClaims);

    // A role with no live claim must run regardless of what changed — it has
    // nothing to reuse.
    const rerun = ROLE_IDS.filter((r) => affected.has(r) || !live.has(r));
    const reused = ROLE_IDS.filter((r) => live.has(r) && !affected.has(r));
    return { rerun, reused, changedKinds };
  }

  /** Applies the decision: invalidates the stale claims and reports the split. */
  async route(revision: CaseRevision): Promise<RoutingDecision> {
    const live = await this.blackboard.liveClaims(revision.caseId);
    const decision = this.plan(revision.changedKinds, live.map((c) => c.role));
    const toInvalidate = decision.rerun.filter((r) => live.some((c) => c.role === r));
    await this.blackboard.invalidateRoles(revision.caseId, toInvalidate);
    return decision;
  }
}
