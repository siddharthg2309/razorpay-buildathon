import { caseList, caseTrail } from "../queries.js";
import { esc, page, panel, rel, rupees, surfaceTag, table } from "../render.js";

/** Case list — the way into Screen 2. */
export async function casesScreen(filter?: string): Promise<string> {
  const rows = await caseList(150, filter);
  const body = table(
    ["case", "domain", "tier", "arm", "amount", "state"],
    rows.map((c) => [
      `<a href="/case/${esc(c.id)}">${esc(c.id)}</a>`,
      `<span class="dim">${esc(c.domain)}</span>`,
      `<span class="tag t${c.tier}">T${c.tier}</span>`,
      c.holdout ? `<span class="tag">HOLDOUT</span>` : `<span class="dim">treated</span>`,
      rupees(Number(c.amount)),
      `<span class="state-${c.state}">${esc(c.state)}</span>`,
    ]),
    [4],
  );
  const filters = ["", "RECOVERED", "UNRECOVERABLE", "OPTED_OUT", "DISPUTED", "SUPPRESSED_BY_INCIDENT"]
    .map((f) => `<a href="/cases${f ? `?state=${f}` : ""}"${filter === f || (!filter && !f) ? ' class="on"' : ""}>${f || "all"}</a>`)
    .join(" · ");
  return page("cases", "cases", `<h1>Cases</h1><p class="note">${filters}</p>${body}`);
}

/**
 * Screen 2 — the trust screen.
 *
 * The complete decision trail, top to bottom, nothing hidden. Every executed
 * row carries a SIM or LIVE badge: this is the screen that proves the honesty
 * claim, so it must never show a simulated action as though it were real.
 */
export async function caseScreen(caseId: string): Promise<string> {
  const { header, origin, entries } = await caseTrail(caseId);
  if (!header) return page("case", "cases", panel("not found", `<p class="note">No case ${esc(caseId)}.</p>`));

  const h = header as Record<string, unknown>;
  const meta = `<div class="kpis">
    <div class="kpi"><div class="v">${rupees(Number(h["amount_paise"]))}</div><div class="k">at risk</div></div>
    <div class="kpi"><div class="v state-${esc(h["state"])}">${esc(h["state"])}</div><div class="k">state</div>
      ${h["terminal_reason"] ? `<div class="sub">${esc(h["terminal_reason"])}</div>` : ""}</div>
    <div class="kpi"><div class="v">T${esc(h["tier"])}</div><div class="k">tier</div></div>
    <div class="kpi"><div class="v">${h["holdout_flag"] ? "HOLDOUT" : "TREATED"}</div><div class="k">arm</div>
      <div class="sub">${h["holdout_flag"] ? "never acted on" : "agent active"}</div></div>
  </div>`;

  let lastKind = "";
  const trail = entries
    .map((e) => {
      const sep = lastKind && lastKind !== e.kind ? "" : "";
      lastKind = e.kind;
      return `<tr class="${sep}">
        <td class="t">${rel(e.ts, origin)}</td>
        <td class="ev">${esc(e.kind)}</td>
        <td class="d">${e.surface ? `${surfaceTag(e.surface)} ` : ""}${esc(e.detail)}</td>
      </tr>`;
    })
    .join("");

  return page(
    `case ${caseId}`,
    "cases",
    `<h1>Case ${esc(caseId)} · obligation ${esc(h["obligation_id"])} · ${esc(h["domain"])}</h1>
     ${meta}
     <div class="panel" style="margin-top:16px">
       <div class="hd">decision trail — every decision and side effect, in order</div>
       <div class="scroll"><table class="trail"><tbody>${trail}</tbody></table></div>
     </div>
     <p class="mono-sm">SIM marks an action executed against the simulator. LIVE marks one
     executed against Razorpay Test Mode. Nothing else in this trail is inferred.</p>`,
  );
}
