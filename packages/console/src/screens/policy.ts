import { readFileSync } from "node:fs";
import { loadPolicy } from "@rra/core";
import { policyBlocks } from "../queries.js";
import { esc, kpi, page, panel, table } from "../render.js";

/** Screen 4 — policy. The active config, with a number behind every rule. */
export async function policyScreen(merchant = "acme-subscriptions"): Promise<string> {
  const path = `${process.cwd()}/policies/${merchant}.yaml`;
  const policy = loadPolicy(path);
  const raw = readFileSync(path, "utf8");
  const decisions = await policyBlocks();

  const blocked = decisions.filter((d) => d.outcome === "block");
  const allowed = decisions.filter((d) => d.outcome === "allow").reduce((s, d) => s + d.n, 0);
  const approvals = decisions.filter((d) => d.outcome === "require_approval").reduce((s, d) => s + d.n, 0);

  const rows = decisions.map((d) => [
    `<span class="tag ${d.outcome === "block" ? "blocked" : d.outcome === "allow" ? "allow" : "approval"}">${d.rule_id}</span>`,
    d.outcome,
    String(d.n),
    `<span class="note">${esc(d.reason)}</span>`,
  ]);

  const caps = table(
    ["channel", "window", "cap"],
    policy.contactCaps.map((c) => [
      c.channel === "*" ? `<span class="tag">ALL CHANNELS</span>` : esc(c.channel),
      `${c.windowDays}d`,
      String(c.max),
    ]),
    [2],
  );

  return page(
    "policy",
    "policy",
    `<h1>Policy ${esc(policy.version)} · ${esc(policy.merchant)}</h1>
     <div class="kpis">
       ${kpi(String(blocked.reduce((s, d) => s + d.n, 0)), "actions blocked", "by a named rule", true)}
       ${kpi(String(allowed), "actions allowed")}
       ${kpi(String(approvals), "sent to approval")}
       ${kpi(`${policy.quietHours.start}–${policy.quietHours.end}`, "quiet hours", policy.quietHours.timezone)}
     </div>
     ${panel("every decision cites a rule", table(["rule", "outcome", "count", "example reason"], rows, [2]))}
     ${panel("contact caps — the * cap is shared across channels", caps)}
     ${panel("active policy, verbatim", `<pre>${esc(raw)}</pre>`)}
     <p class="mono-sm">Regulatory constraints live here as versioned config, not code: they differ
     per merchant and change over time, and the ledger records which version authorised each action.</p>`,
  );
}
