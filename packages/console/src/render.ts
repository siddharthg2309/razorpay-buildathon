import { CSS } from "./tokens.js";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export const rupees = (paise: number | string | null): string => {
  const p = Number(paise ?? 0);
  const r = p / 100;
  if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(2)} Cr`;
  if (Math.abs(r) >= 1e5) return `₹${(r / 1e5).toFixed(2)} L`;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};

export const pct = (x: number | null): string => `${((Number(x) || 0) * 100).toFixed(1)}%`;

/** Virtual-clock offsets read better than wall timestamps on this content. */
export const rel = (ts: Date, origin: Date): string => {
  const ms = ts.getTime() - origin.getTime();
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0
    ? `${d}d ${String(h).padStart(2, "0")}h`
    : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const NAV = [
  ["/", "overview"],
  ["/cases", "cases"],
  ["/incidents", "incidents"],
  ["/attribution", "attribution"],
  ["/ablation", "model"],
  ["/metrics", "metrics"],
  ["/policy", "policy"],
  ["/stream", "live"],
] as const;

export function page(title: string, active: string, body: string): string {
  const nav = NAV.map(
    ([href, label]) => `<a href="${href}"${active === label ? ' class="on"' : ""}>${label}</a>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Recovery Agent</title><style>${CSS}</style></head>
<body><header class="masthead">
<div class="wordmark">Recovery Agent<span>revenue at risk, recovered and measured</span></div>
<nav>${nav}</nav></header>
<main>${body}</main></body></html>`;
}

/** Page opener: one line of what this is, one of what it is for. */
export const head = (title: string, dek: string): string =>
  `<h1>${esc(title)}</h1><p class="dek">${dek}</p>`;

export const section = (label: string, inner: string): string =>
  `<section><h2>${esc(label)}</h2>${inner}</section>`;

/**
 * The headline figure. Size is reserved for the number that matters; anything
 * shown beside it for comparison is set quiet so the eye is not asked to
 * choose between them.
 */
export const figure = (
  amount: string,
  caption: string,
  under = "",
  quiet = false,
): string =>
  `<div class="figure"><span class="amount${quiet ? " quiet" : ""}">${esc(amount)}</span>
   <div class="caption">${esc(caption)}</div>
   ${under ? `<div class="under">${under}</div>` : ""}</div>`;

export const lede = (figures: string[]): string =>
  `<div class="lede">${figures.join("")}</div>`;

export const measure = (v: string, k: string, s = "", quiet = false): string =>
  `<div class="measure"><div class="v${quiet ? " quiet" : ""}">${esc(v)}</div>
   <div class="k">${esc(k)}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;

export const measures = (items: string[]): string =>
  `<div class="measures">${items.join("")}</div>`;

/** SIM or LIVE. Screen 2 exists to prove the honesty claim, so every executed
 *  row has to say which world it happened in. */
export const surfaceTag = (surface: string): string =>
  surface === "live"
    ? `<span class="mark live">LIVE</span>`
    : `<span class="mark">SIM</span>`;

export const bar = (fraction: number, quiet = false): string =>
  `<div class="bar${quiet ? " quiet" : ""}"><span style="width:${Math.max(0, Math.min(1, fraction)) * 100}%"></span></div>`;

export function table(
  headers: readonly string[],
  rows: readonly string[][],
  numeric: readonly number[] = [],
): string {
  if (rows.length === 0) return `<p class="empty">Nothing to show yet.</p>`;
  const th = headers
    .map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ""}>${esc(h)}</th>`)
    .join("");
  const tr = rows
    .map(
      (r) =>
        `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

export const empty = (what: string): string => `<p class="empty">${what}</p>`;
export const hint = (text: string): string => `<p class="hint">${text}</p>`;
