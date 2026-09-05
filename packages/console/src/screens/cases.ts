import { caseList, caseTrail } from "../queries.js";
import { card, esc, grid, page, pageHead, rel, rupees, section, stat, surfaceTag, table } from "../render.js";

const FILTERS = ["", "RECOVERED", "UNRECOVERABLE", "OPTED_OUT", "DISPUTED", "SUPPRESSED_BY_INCIDENT"] as const;

export async function casesScreen(filter?: string): Promise<string> {
  const rows = await caseList(150, filter);

  const filters = `<div class="filters">${FILTERS.map((f) => {
    const on = filter === f || (!filter && !f);
    const label = f ? f.replace(/_/g, " ").toLowerCase() : "all";
    return `<a href="/cases${f ? `?state=${f}` : ""}"${on ? ' class="on"' : ""}>${label}</a>`;
  }).join("")}</div>`;

  const body = table(
    ["case", "domain", "tier", "arm", "at risk", "outcome"],
    rows.map((c) => [
      `<a href="/case/${esc(c.id)}" class="mono">${esc(c.id)}</a>`,
      esc(c.domain.replace(/_/g, " ")),
      `<span class="chip">T${c.tier}</span>`,
      c.holdout ? `<span class="chip">held back</span>` : `<span style="color:var(--muted)">treated</span>`,
      rupees(Number(c.amount)),
      `<span class="state state-${c.state}">${esc(c.state.replace(/_/g, " ").toLowerCase())}</span>`,
    ]),
    [4],
  );

  return page(
    "Cases",
    "/cases",
    `${pageHead("Cases", "Open one to read what it did, and why.")}
     ${filters}
     ${card("", body, `${rows.length} shown`, true)}`,
  );
}

/** Steps that carry the audit weight, picked out in the trail. */
const KEY_STEPS = new Set(["POLICY", "TOKEN", "EXECUTE", "SETTLEMENT", "TERMINAL_REACHED"]);

/**
 * One case, end to end.
 *
 * The audit-trail requirement rests on this screen, so it is a reading surface:
 * one column, in order, nothing hidden and nothing summarised. The rows that
 * carry weight are shaded so a reader can find them without being told.
 */
export async function caseScreen(caseId: string): Promise<string> {
  const { header, origin, entries } = await caseTrail(caseId);
  if (!header) {
    return page("Case not found", "/cases", pageHead("Not found", `No case <code>${esc(caseId)}</code>.`));
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
    "Cases",
    "/cases",
    `${pageHead(
      esc(caseId),
      `${esc(String(h["domain"]).replace(/_/g, " "))} · obligation <code>${esc(h["obligation_id"])}</code>`,
    )}
     ${grid(4, [
       stat("At risk", rupees(Number(h["amount_paise"]))),
       stat("Outcome", state.replace(/_/g, " ").toLowerCase(),
         h["terminal_reason"] ? esc(h["terminal_reason"]) : "",
         state === "RECOVERED" ? "hero" : "quiet"),
       stat("Decided by", `Tier ${h["tier"]}`, h["tier"] === 0 ? "taxonomy" : "specialists"),
       stat("Arm", h["holdout_flag"] ? "held back" : "treated",
         "",
         h["holdout_flag"] ? "quiet" : "normal"),
     ])}
     ${section("", card("What happened, in order",
       `<div class="scroll"><table class="trail"><tbody>${trail}</tbody></table></div>`,
       `${entries.length} entries`, true))}
`,
  );
}
