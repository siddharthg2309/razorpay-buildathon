import type { ServerResponse } from "node:http";
import { getPool } from "@rra/db";

export interface StreamLine {
  id: number;
  caseId: string;
  kind: string;
  text: string;
}

const KINDS: Record<string, string> = {
  plan_selected: "TIER0",
  degraded_escalation: "TIER1",
  claim_written: "CLAIM",
  plan_optimized: "TIER1",
  recovered: "VERIFY",
  unrecoverable: "VERIFY",
  partial_settlement: "VERIFY",
  incident_opened: "INCIDENT",
  cases_parked: "INCIDENT",
  cases_released: "INCIDENT",
  cases_reparked: "INCIDENT",
  release_released: "INCIDENT",
  release_reparked: "INCIDENT",
  agent_run_failed: "BLOCK",
};

const short = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "").slice(0, 90);
};

/**
 * Both surfaces read the same event stream — the web console and the terminal
 * view are two renderings of one source, not two implementations.
 */
export async function readSince(afterId: number, limit = 400): Promise<StreamLine[]> {
  const { rows } = await getPool().query<{
    id: string; case_id: string; actor: string; event_type: string; payload: Record<string, unknown>;
  }>(
    `SELECT id, case_id, actor, event_type, payload FROM ledger
      WHERE id > $1 ORDER BY id LIMIT $2`,
    [afterId, limit],
  );

  const lines: StreamLine[] = [];
  for (const r of rows) {
    const kind = KINDS[r.event_type];
    if (!kind) continue;
    const p = r.payload;
    let text: string;
    switch (r.event_type) {
      case "plan_selected":
        text = `rule ${p["ruleId"]} · ${p["cause"]}`;
        break;
      case "plan_optimized":
        text = `selected ${p["selected"] ?? "none"} · resolved by ${p["resolvedBy"]}`;
        break;
      case "claim_written":
        text = `${r.actor.replace("agent:", "")} · ${p["usedProvider"] ? `${p["provider"]}/${p["model"]}` : "deterministic"}`;
        break;
      case "degraded_escalation":
        text = `degraded → escalate · ${p["reason"]}`;
        break;
      case "recovered":
        text = `RECOVERED ${Number(p["settled"] ?? 0) / 100} · matched by ${p["matchedBy"]}`;
        break;
      case "incident_opened":
        text = `${p["label"]} · z=${Number(p["z"] ?? 0).toFixed(1)} n=${p["n"]} → OPEN`;
        break;
      case "cases_parked":
        text = `${p["parked"]} cases suspended`;
        break;
      default:
        text = short(p);
    }
    lines.push({ id: Number(r.id), caseId: r.case_id, kind, text });
  }
  return lines;
}

/** Server-sent events. Polls the ledger, which is append-only and monotonic. */
export function sse(res: ServerResponse, startAfter: number): () => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let cursor = startAfter;
  let closed = false;

  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      const lines = await readSince(cursor, 200);
      for (const l of lines) {
        cursor = l.id;
        res.write(`data: ${JSON.stringify(l)}\n\n`);
      }
    } catch {
      // A transient query failure must not kill the stream mid-demo.
    }
    if (!closed) setTimeout(() => void tick(), 400);
  };
  void tick();

  return () => {
    closed = true;
  };
}
