import { caseList, caseTrail } from "../queries.js";
import { esc, head, hint, measure, measures, page, rel, rupees, section, surfaceTag, table } from "../render.js";

const FILTERS = ["", "RECOVERED", "UNRECOVERABLE", "OPTED_OUT", "DISPUTED", "SUPPRESSED_BY_INCIDENT"] as const;

export async function casesScreen(filter?: string): Promise<string> {
  const rows = await caseList(150, filter);

  const nav = FILTERS.map((f) => {
    const on = filter === f || (!filter && !f);
    return `<a href="/cases${f ? `?state=${f}` : ""}" class="mark${on ? " on" : ""}">${f ? f.replace(/_/g, " ").toLowerCase() : "all"}</a>`;
  }).join(" ");

  const body = table(
    ["case", "domain", "tier", "arm", "at risk", "outcome"],
    rows.map((c) => [
      `<a href="/case/${esc(c.id)}" class="mono">${esc(c.id)}</a>`,
      esc(c.domain.replace(/_/g, " ")),
      `<span class="mono">T${c.tier}</span>`,
      c.holdout ? `<span class="mark">held back</span>` : `<span class="mono">treated</span>`,
      rupees(Number(c.amount)),
      `<span class="state state-${c.state}">${esc(c.state.replace(/_/g, " "))}</span>`,
    ]),
    [4],
  );

  return page(
    "cases",
    "cases",
    `${head("Cases", "Every obligation the agent opened. Open one to read what it did and why.")}
     <div style="margin-bottom:26px">${nav}</div>
     ${body}`,
  );
}

/** Steps that carry the audit weight, emphasised in the trail. */
const KEY_STEPS = new Set(["POLICY", "TOKEN", "EXECUTE", "SETTLEMENT", "TERMINAL_REACHED"]);

/**
 * One case, end to end.
 *
 * This is the screen the audit-trail requirement rests on, so it is a reading
 * surface rather than a dashboard: a single column, in order, nothing hidden
 * and nothing summarised.
 */
export async function caseScreen(caseId: string): Promise<string> {
  const { header, origin, entries } = await caseTrail(caseId);
  if (!header) {
    return page("case", "cases", head("Not found", `No case <code>${esc(caseId)}</code>.`));
  }

  const h = header as Record<string, unknown>;
  const state = String(h["state"]);

  const trail = entries
    .map(
      (e) => `<tr${KEY_STEPS.has(e.kind) ? ' class="key"' : ""}>
        <td class="t">${rel(e.ts, origin)}</td>
        <td class="ev">${esc(e.kind.replace(/_/g, " "))}</td>
        <td class="d">${e.surface ? `${surfaceTag(e.surface)} ` : ""}${esc(e.detail)}</td>
      </tr>`,
    )
    .join("");

  return page(
    `case ${caseId}`,
    "cases",
    `${head(
      esc(caseId),
      `${esc(String(h["domain"]).replace(/_/g, " "))} · obligation <code>${esc(h["obligation_id"])}</code>`,
    )}
     ${measures([
       measure(rupees(Number(h["amount_paise"])), "at risk"),
       measure(
         state.replace(/_/g, " "),
         "outcome",
         h["terminal_reason"] ? esc(h["terminal_reason"]) : "",
         state !== "RECOVERED",
       ),
       measure(`Tier ${h["tier"]}`, "decided by", h["tier"] === 0 ? "taxonomy, no model" : "specialists"),
       measure(h["holdout_flag"] ? "held back" : "treated", "arm",
         h["holdout_flag"] ? "never contacted" : "agent acted", Boolean(h["holdout_flag"])),
     ])}
     ${section("what happened, in order", `<div class="scroll"><table class="trail"><tbody>${trail}</tbody></table></div>`)}
     ${hint(
       `<span class="mark live">LIVE</span> marks an action executed against Razorpay Test Mode.
        <span class="mark">SIM</span> marks one executed against the simulator. Nothing in this
        trail is inferred after the fact — each line was written when it happened.`,
     )}`,
  );
}
