import { createHash, randomUUID } from "node:crypto";
import {
  ROLE_REGISTRY,
  type ActionLibrary,
  type CaseRevision,
  type Clock,
  type DeclineTaxonomy,
  type RoleId,
} from "@rra/core";
import { Ledger } from "@rra/db";
import type { Blackboard } from "@rra/engine";
import type { LLMProvider } from "./provider.js";
import type { ContextClaim, DiagnosisClaim, EconomicsClaim, IncidentClaim } from "./claims.js";
import {
  correlateIncident,
  diagnose,
  readContext,
  valueActions,
  type SpecialistInput,
  type SpecialistOutcome,
} from "./specialists.js";

export interface RunResult {
  revision: number;
  ran: RoleId[];
  failed: { role: RoleId; error: string }[];
  providerCalls: number;
  claims: {
    diagnosis?: DiagnosisClaim;
    context?: ContextClaim;
    incident?: IncidentClaim;
    economics?: EconomicsClaim;
  };
}

const inputHash = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/**
 * Runs the specialists the work router selected, concurrently.
 *
 * Every run and claim is written against one case revision before the reducer
 * sees anything. That binding is what makes a Tier 1 decision replayable: you
 * can point at the exact inputs each role saw.
 *
 * Promise.allSettled, not Promise.all — one role timing out must not discard
 * the four that succeeded. A failed role simply leaves no claim, and the
 * reducer works with what it has.
 */
export class AgentRuntime {
  private readonly ledger: Ledger;

  constructor(
    private readonly blackboard: Blackboard,
    private readonly library: ActionLibrary,
    private readonly taxonomy: DeclineTaxonomy,
    private readonly clock: Clock,
    private readonly provider: LLMProvider | null = null,
  ) {
    this.ledger = new Ledger(clock);
  }

  async run(
    revision: CaseRevision,
    roles: readonly RoleId[],
    input: SpecialistInput,
    allowedActionIds: readonly string[],
  ): Promise<RunResult> {
    const tasks = roles.map((role) => ({ role, work: this.#invoke(role, input, allowedActionIds) }));
    const settled = await Promise.allSettled(tasks.map((t) => t.work));

    const ran: RoleId[] = [];
    const failed: { role: RoleId; error: string }[] = [];
    const claims: RunResult["claims"] = {};
    let providerCalls = 0;

    for (const [i, outcome] of settled.entries()) {
      const role = tasks[i]!.role;
      const runId = randomUUID();
      const hash = inputHash({ role, input, allowedActionIds });

      if (outcome.status === "rejected") {
        const error = (outcome.reason as Error).message;
        failed.push({ role, error });
        await this.blackboard.recordRun({
          id: runId, caseId: input.caseId, revision: revision.revision, role,
          status: /timeout/i.test(error) ? "timeout" : "error", inputHash: hash,
        });
        await this.ledger.append({
          caseId: input.caseId, actor: `agent:${role}`, eventType: "agent_run_failed",
          payload: { revision: revision.revision, error },
        });
        continue;
      }

      const value = outcome.value as SpecialistOutcome<unknown>;
      if (value.usedProvider) providerCalls++;
      ran.push(role);

      await this.blackboard.recordRun({
        id: runId, caseId: input.caseId, revision: revision.revision, role,
        status: "ok", inputHash: hash,
        ...(value.provider !== undefined ? { provider: value.provider } : {}),
        ...(value.model !== undefined ? { model: value.model } : {}),
        ...(value.latencyMs !== undefined ? { latencyMs: value.latencyMs } : {}),
      });

      await this.blackboard.writeClaim({
        id: randomUUID(),
        caseId: input.caseId,
        revision: revision.revision,
        role,
        payload: value.claim as Record<string, unknown>,
        evidenceRefs: input.evidenceRefs,
        agentRunId: runId,
      });

      await this.ledger.append({
        caseId: input.caseId,
        actor: `agent:${role}`,
        eventType: "claim_written",
        payload: {
          revision: revision.revision,
          usedProvider: value.usedProvider,
          provider: value.provider ?? null,
          model: value.model ?? null,
          cachedInputTokens: value.cachedInputTokens ?? null,
        },
      });

      switch (role) {
        case "payment_diagnosis": claims.diagnosis = value.claim as DiagnosisClaim; break;
        case "customer_context": claims.context = value.claim as ContextClaim; break;
        case "incident_intelligence": claims.incident = value.claim as IncidentClaim; break;
        case "recovery_economics": claims.economics = value.claim as EconomicsClaim; break;
        case "communication": break;
      }
    }

    return { revision: revision.revision, ran, failed, providerCalls, claims };
  }

  #invoke(
    role: RoleId,
    input: SpecialistInput,
    allowedActionIds: readonly string[],
  ): Promise<SpecialistOutcome<unknown>> {
    const contract = ROLE_REGISTRY[role];
    // A role whose contract forbids provider use never receives one, so the
    // budget is structural rather than a number someone remembers to check.
    const provider = contract.mayUseProvider ? this.provider : null;

    const work = (): Promise<SpecialistOutcome<unknown>> => {
      switch (role) {
        case "payment_diagnosis":
          return diagnose(input, this.taxonomy, provider);
        case "customer_context":
          return readContext(input, provider);
        case "incident_intelligence":
          return Promise.resolve(correlateIncident(input));
        case "recovery_economics":
          return Promise.resolve(
            valueActions(input, this.library, input.code, allowedActionIds),
          );
        case "communication":
          return Promise.resolve({
            claim: { templateId: "WA_GENERIC_DUE", language: input.language, slots: {} },
            usedProvider: false,
          });
      }
    };

    return withTimeout(work(), contract.timeoutMs, role);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, role: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`role ${role} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
