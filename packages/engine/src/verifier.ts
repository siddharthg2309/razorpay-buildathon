import type { Clock, TerminalState } from "@rra/core";
import { CaseEventStore, Ledger, getPool } from "@rra/db";
import type { Reconciler, InboundSettlement } from "./reconciler.js";

export type VerificationOutcome =
  | { kind: "recovered"; settledPaise: number }
  | { kind: "partial"; settledPaise: number; owedPaise: number }
  | { kind: "unmatched" }
  | { kind: "no_open_case" };

export interface OutcomeSignal {
  caseId: string;
  /** What the connector or a webhook reported. */
  result: "succeeded" | "failed" | "opted_out" | "disputed";
  detail?: Record<string, unknown>;
}

/**
 * Decides whether money actually arrived, and moves the case accordingly.
 *
 * The rule the whole product rests on: a case reaches RECOVERED only when a
 * settlement is matched to its obligation and covers what was owed. A
 * successful connector call is not a recovery — a delivered WhatsApp template
 * moves nothing.
 */
export class Verifier {
  private readonly events: CaseEventStore;

  constructor(
    private readonly reconciler: Reconciler,
    private readonly ledger: Ledger,
    private readonly clock: Clock,
  ) {
    this.events = new CaseEventStore(clock);
  }

  /** Money arrived. Match it, then close the case if it is fully settled. */
  async onSettlement(s: InboundSettlement): Promise<VerificationOutcome> {
    const match = await this.reconciler.record(s);
    if (!match.obligationId) return { kind: "unmatched" };

    const { rows } = await getPool().query<{ id: string; amount_paise: string }>(
      `SELECT c.id, o.amount_paise
         FROM cases c JOIN obligations o ON o.id = c.obligation_id
        WHERE c.obligation_id = $1 AND c.closed_at IS NULL
        ORDER BY c.opened_at LIMIT 1`,
      [match.obligationId],
    );
    const openCase = rows[0];
    if (!openCase) return { kind: "no_open_case" };

    const settled = await this.reconciler.settledAmount(match.obligationId);
    const owed = Number(openCase.amount_paise);

    if (settled < owed) {
      await this.ledger.append({
        caseId: openCase.id,
        actor: "verifier",
        eventType: "partial_settlement",
        payload: { settled, owed, matchedBy: match.matchedBy },
      });
      return { kind: "partial", settledPaise: settled, owedPaise: owed };
    }

    await getPool().query("UPDATE obligations SET state = 'settled' WHERE id = $1", [match.obligationId]);
    // The terminal write cancels every pending scheduled action in the same
    // transaction — that is how the rest of the dunning sequence stops.
    await this.events.append(
      openCase.id,
      { type: "terminal_reached", state: "RECOVERED", reason: `settled_via_${match.matchedBy}` },
      "verifier",
    );
    await this.ledger.append({
      caseId: openCase.id,
      actor: "verifier",
      eventType: "recovered",
      payload: { settled, owed, matchedBy: match.matchedBy, settlementId: s.id },
    });
    return { kind: "recovered", settledPaise: settled };
  }

  /**
   * A connector outcome that is not money. Only the terminal signals close a
   * case; a failed attempt returns it to observation so the scheduler can run
   * the next step.
   */
  async onOutcome(signal: OutcomeSignal): Promise<void> {
    const terminal: Partial<Record<OutcomeSignal["result"], TerminalState>> = {
      opted_out: "OPTED_OUT",
      disputed: "DISPUTED",
    };
    const state = terminal[signal.result];

    if (state) {
      await this.events.append(
        signal.caseId,
        { type: "terminal_reached", state, reason: signal.result },
        "verifier",
      );
    } else {
      await this.events.append(
        signal.caseId,
        { type: "outcome_observed", outcome: signal.result },
        "verifier",
      );
    }
    await this.ledger.append({
      caseId: signal.caseId,
      actor: "verifier",
      eventType: `outcome_${signal.result}`,
      payload: signal.detail ?? {},
    });
  }

  /** No further action is permitted and no money arrived. */
  async exhaust(caseId: string, reason: string): Promise<void> {
    await this.events.append(
      caseId,
      { type: "terminal_reached", state: "UNRECOVERABLE", reason },
      "verifier",
    );
    await this.ledger.append({ caseId, actor: "verifier", eventType: "unrecoverable", payload: { reason } });
  }
}
