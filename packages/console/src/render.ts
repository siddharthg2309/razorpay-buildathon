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

/** Virtual-clock offsets read better than absolute timestamps on this content. */
export const rel = (ts: Date, origin: Date): string => {
  const ms = ts.getTime() - origin.getTime();
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `T+${d}d${String(h).padStart(2, "0")}h` : `T+${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}`;
};

const NAV = [
  ["/", "batch"],
  ["/cases", "cases"],
  ["/incidents", "incidents"],
  ["/policy", "policy"],
  ["/attribution", "attribution"],
  ["/metrics", "metrics"],
  ["/ablation", "ablation"],
  ["/stream", "stream"],
] as const;

export function page(title: string, active: string, body: string): string {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${active === label ? ' class="on"' : ""}>${label}</a>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · recovery agent</title><style>${CSS}</style></head>
<body><header class="top"><span class="brand">REVENUE RECOVERY AGENT</span><nav>${nav}</nav></header>
<main>${body}</main></body></html>`;
}

export const kpi = (value: string, key: string, sub = "", accent = false): string =>
  `<div class="kpi"><div class="v${accent ? " accent" : ""}">${esc(value)}</div><div class="k">${esc(key)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>`;

export const panel = (heading: string, inner: string): string =>
  `<div class="panel"><div class="hd">${esc(heading)}</div>${inner}</div>`;

/** SIM/LIVE marker. Screen 2 exists to prove the honesty claim, so every
 *  executed row has to say which world it happened in. */
export const surfaceTag = (surface: string): string =>
  surface === "live"
    ? `<span class="tag live">LIVE</span>`
    : `<span class="tag sim">SIM</span>`;

export const bar = (fraction: number, muted = false): string =>
  `<div class="bar${muted ? " muted" : ""}"><span style="width:${Math.max(0, Math.min(1, fraction)) * 100}%"></span></div>`;

export function table(headers: readonly string[], rows: readonly string[][], numeric: readonly number[] = []): string {
  const th = headers.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ""}>${esc(h)}</th>`).join("");
  const tr = rows
    .map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}
