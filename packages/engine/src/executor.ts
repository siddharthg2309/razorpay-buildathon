import { createHash } from "node:crypto";
import {
  CapabilityMinter,
  hashParams,
  type ActionLibrary,
  type CapabilityToken,
  type Clock,
} from "@rra/core";
import { getPool } from "@rra/db";
import {
  invoke,
  UnsupportedCapabilityError,
  type CallResult,
  type CapabilityName,
  type PSPAdapter,
} from "@rra/connectors";
import { TokenBurner } from "./token-burn.js";
import { ObligationLease } from "./obligation-lease.js";

/** idem_key = sha256(case | action | attempt | params_hash) */
export function idempotencyKey(
  caseId: string,
  actionId: string,
  attemptNo: number,
  params: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update([caseId, actionId, String(attemptNo), hashParams(params)].join("|"))
    .digest("hex");
}

export interface ExecuteRequest {
  caseId: string;
  obligationId: string;
  customerId: string;
  actionId: string;
  attemptNo: number;
  params: Record<string, unknown>;
  token: CapabilityToken;
  amountPaise?: number;
}

export interface ExecuteResult {
  idemKey: string;
  surface: "live" | "simulated";
  result: CallResult;
}

export class ScheduleActionNotExecutableError extends Error {
  constructor(actionId: string) {
    super(`${actionId} is a schedule action: it writes a scheduled_actions row, not a connector call`);
    this.name = "ScheduleActionNotExecutableError";
  }
}

/**
 * The executor. Holds the obligation lease, runs connector admission, and
 * writes the attempt record before the call.
 *
 * The ordering matters more than anything else here: the action_attempts row
 * with its unique idem_key is written BEFORE the external call and updated
 * after. A crash in between leaves an in_flight row that reconcile() resolves
 * by asking the PSP about the same key — never by re-issuing.
 */
export class Executor {
  constructor(
    private readonly adapter: PSPAdapter,
    private readonly library: ActionLibrary,
    private readonly minter: CapabilityMinter,
    private readonly burner: TokenBurner,
    private readonly lease: ObligationLease,
    private readonly clock: Clock,
  ) {}

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const action = this.library.get(req.actionId);
    if (action.kind === "schedule") throw new ScheduleActionNotExecutableError(req.actionId);

    const capability = action.capability as CapabilityName;
    // Refused before execution, not discovered during it.
    if (!this.adapter.capabilities().has(capability)) {
      throw new UnsupportedCapabilityError(this.adapter.name, capability);
    }

    // Admission steps 1-3. The token is the only thing that authorises this.
    this.minter.verify(req.token, {
      actionId: req.actionId,
      params: req.params,
      ...(req.amountPaise !== undefined ? { amountPaise: req.amountPaise } : {}),
    });

    const idemKey = idempotencyKey(req.caseId, req.actionId, req.attemptNo, req.params);

    // The lease is taken here — at admission — not during deliberation.
    return this.lease.withLease(req.obligationId, `executor:${req.caseId}`, async () => {
      // Step 4: burning the nonce. A replayed token dies here, before the call.
      await this.burner.burn(req.token);

      await getPool().query(
        `INSERT INTO action_attempts
           (id, case_id, obligation_id, action_id, attempt_no, idem_key, surface, state, request, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'in_flight',$8,$9)`,
        [
          idemKey, req.caseId, req.obligationId, req.actionId, req.attemptNo, idemKey,
          this.adapter.surface, JSON.stringify(req.params), this.clock.now(),
        ],
      );

      try {
        const result = await invoke(
          this.adapter,
          capability,
          {
            caseId: req.caseId,
            obligationId: req.obligationId,
            customerId: req.customerId,
            params: req.params,
            idemKey,
          },
          req.token,
        );
        await this.#settle(idemKey, result.ok ? "succeeded" : "failed", result);
        return { idemKey, surface: this.adapter.surface, result };
      } catch (err) {
        // Deliberately left in_flight: we do not know whether the provider saw
        // it. Reconciliation, not a retry, decides.
        throw err;
      }
    });
  }

  async #settle(idemKey: string, state: string, result: CallResult): Promise<void> {
    await getPool().query(
      `UPDATE action_attempts SET state = $2, response = $3, settled_at = $4 WHERE idem_key = $1`,
      [idemKey, state, JSON.stringify(result), this.clock.now()],
    );
  }

  /**
   * Boot-time reconciliation. Every in_flight row is resolved by asking the PSP
   * about its idempotency key. This is what prevents a crash between call and
   * response from double-charging.
   */
  async reconcile(): Promise<{ reconciled: number; stillUnknown: number }> {
    const { rows } = await getPool().query<{ idem_key: string }>(
      "SELECT idem_key FROM action_attempts WHERE state = 'in_flight' ORDER BY sent_at",
    );
    let reconciled = 0;
    let stillUnknown = 0;

    for (const row of rows) {
      const status = await this.adapter.fetchPaymentStatus(row.idem_key);
      if (!status.found) {
        stillUnknown++;
        continue;
      }
      await getPool().query(
        `UPDATE action_attempts SET state = 'reconciled', response = $2, settled_at = $3 WHERE idem_key = $1`,
        [row.idem_key, JSON.stringify(status), this.clock.now()],
      );
      reconciled++;
    }
    return { reconciled, stillUnknown };
  }

  async attemptsFor(caseId: string): Promise<
    { idemKey: string; actionId: string; state: string; surface: string }[]
  > {
    const { rows } = await getPool().query<{
      idem_key: string; action_id: string; state: string; surface: string;
    }>(
      "SELECT idem_key, action_id, state, surface FROM action_attempts WHERE case_id = $1 ORDER BY sent_at",
      [caseId],
    );
    return rows.map((r) => ({
      idemKey: r.idem_key, actionId: r.action_id, state: r.state, surface: r.surface,
    }));
  }
}
