import { readFileSync } from "node:fs";
import { loadPolicy } from "@rra/core";
import { policyBlocks } from "../queries.js";
import { card, esc, grid, hint, page, pageHead, section, stat, table } from "../render.js";

/** Policy — the rules, each with a count behind it. */
export async function policyScreen(merchant = "acme-subscriptions"): Promise<string> {
  const path = `${process.cwd()}/policies/${merchant}.yaml`;
  const policy = loadPolicy(path);
  const raw = readFileSync(path, "utf8");
  const decisions = await policyBlocks();

  const sum = (o: string) => decisions.filter((d) => d.outcome === o).reduce((s, d) => s + d.n, 0);

  const rows = decisions.map((d) => [
    `<span class="chip">${d.rule_id}</span>`,
    d.outcome === "block" ? "refused" : d.outcome === "allow" ? "allowed" : "sent for approval",
    esc(d.reason),
    String(d.n),
  ]);

  const caps = table(
    ["channel", "window", "limit"],
    policy.contactCaps.map((c) => [
      c.channel === "*" ? `<strong>all channels together</strong>` : esc(c.channel),
      `${c.windowDays} days`,
      String(c.max),
    ]),
    [2],
  );

  return page(
    "Policy",
    "/policy",
    `${pageHead("What the agent is allowed to do", `Version ${esc(policy.version)}, for ${esc(policy.merchant)}. Every action cites the rule that permitted it.`)}
     ${grid(4, [
       stat("Actions refused", String(sum("block")), "each by a named rule", "hero"),
       stat("Actions permitted", String(sum("allow")), "", "quiet"),
       stat("Sent to a person", String(sum("require_approval")), "", "quiet"),
       stat("Quiet hours", `${policy.quietHours.start}–${policy.quietHours.end}`, esc(policy.quietHours.timezone)),
     ])}
     ${section("Every decision, and the rule behind it",
       card("", table(["rule", "outcome", "reason", "count"], rows, [3]), "", true))}
     ${section("How often one customer can be contacted", card("", caps, "", true))}
     ${hint(`The limit across all channels is what stops three separate per-channel allowances
       becoming one customer contacted ten times in a week.`)}
     ${section("The policy in force, verbatim", card("", `<pre>${esc(raw)}</pre>`))}`,
  );
}
