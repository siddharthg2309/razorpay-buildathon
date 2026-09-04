import { readFileSync } from "node:fs";
import { loadPolicy } from "@rra/core";
import { policyBlocks } from "../queries.js";
import { esc, head, hint, measure, measures, page, section, table } from "../render.js";

/** Policy — the rules, and a count behind each. */
export async function policyScreen(merchant = "acme-subscriptions"): Promise<string> {
  const path = `${process.cwd()}/policies/${merchant}.yaml`;
  const policy = loadPolicy(path);
  const raw = readFileSync(path, "utf8");
  const decisions = await policyBlocks();

  const blocked = decisions.filter((d) => d.outcome === "block").reduce((s, d) => s + d.n, 0);
  const allowed = decisions.filter((d) => d.outcome === "allow").reduce((s, d) => s + d.n, 0);
  const approvals = decisions.filter((d) => d.outcome === "require_approval").reduce((s, d) => s + d.n, 0);

  const rows = decisions.map((d) => [
    `<span class="mono">${d.rule_id}</span>`,
    d.outcome === "block" ? "refused" : d.outcome === "allow" ? "allowed" : "sent for approval",
    esc(d.reason),
    String(d.n),
  ]);

  const caps = table(
    ["channel", "window", "limit"],
    policy.contactCaps.map((c) => [
      c.channel === "*" ? `<span class="key">all channels together</span>` : esc(c.channel),
      `${c.windowDays} days`,
      String(c.max),
    ]),
    [2],
  );

  return page(
    "policy",
    "policy",
    `${head("What the agent is allowed to do", `Version ${esc(policy.version)}, for ${esc(policy.merchant)}. Every action cites the rule that permitted it.`)}
     ${measures([
       measure(String(blocked), "actions refused", "each by a named rule"),
       measure(String(allowed), "actions permitted", "", true),
       measure(String(approvals), "sent to a person", "", true),
       measure(`${policy.quietHours.start}–${policy.quietHours.end}`, "quiet hours", esc(policy.quietHours.timezone)),
     ])}
     ${section("every decision, and the rule behind it", table(["rule", "outcome", "reason", "count"], rows, [3]))}
     ${section("how often a customer can be contacted", caps)}
     ${hint(`The limit across all channels is what stops three separate per-channel allowances
       becoming one customer contacted ten times in a week.`)}
     ${section("the policy in force, verbatim", `<pre>${esc(raw)}</pre>`)}`,
  );
}
