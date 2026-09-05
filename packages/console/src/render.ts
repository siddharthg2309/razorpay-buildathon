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

/**
 * Navigation, grouped by the question each screen answers.
 *
 * A flat list of eight items makes the reader hunt. Grouped, the shape of the
 * product is legible from the sidebar alone: what happened, what it recovered,
 * what it was allowed to do.
 */
const NAV: [string, [string, string][]][] = [
  ["Run", [["/", "Overview"], ["/stream", "Live activity"]]],
  ["Recovery", [["/cases", "Cases"], ["/incidents", "Incidents"]]],
  ["Evidence", [["/attribution", "Attribution"], ["/ablation", "Model"], ["/metrics", "Breakdown"]]],
  ["Rules", [["/policy", "Policy"]]],
];

/**
 * One atmospheric orb per screen, keyed by route.
 *
 * design.md's chroma is entirely decorative, so this is the only place a hue
 * is chosen and it is chosen from where you are standing, not from what the
 * data says. Nothing on the page reads the orb, and no value changes it.
 */
const ORBS: Record<string, string> = {
  "/": "mint",
  "/stream": "sky",
  "/cases": "peach",
  "/incidents": "rose",
  "/attribution": "lavender",
  "/ablation": "lavender",
  "/metrics": "sky",
  "/policy": "peach",
};

export interface Chrome {
  /** Shown under the nav: which run is on screen. */
  footer?: string;
}

export function page(title: string, active: string, body: string, chrome: Chrome = {}): string {
  const nav = NAV.map(
    ([group, items]) => `<div class="navgroup"><h3>${esc(group)}</h3><nav>${items
      .map(([href, label]) =>
        `<a href="${href}"${href === active ? ' class="on"' : ""}>${esc(label)}</a>`)
      .join("")}</nav></div>`,
  ).join("");

  return `<!doctype html><html lang="en" data-orb="${ORBS[active] ?? "mint"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Recovery Agent</title><style>${CSS}</style></head>
<body><div class="shell">
<aside>
  <div class="brand"><b>Recovery Agent</b></div>
  ${nav}
  ${chrome.footer ? `<div class="sidefoot">${chrome.footer}</div>` : ""}
</aside>
<main>${body}</main>
</div></body></html>`;
}

/**
 * The orb sits inside the head, behind the display line, containing nothing.
 *
 * There is no dek. `id` switches the heading to the monospace face: a case id
 * or a segment key is a technical identifier, and setting one in a light
 * editorial serif reads as a typo rather than a title.
 */
export const pageHead = (title: string, id = false): string =>
  `<div class="pagehead"><div class="orb"></div>
     <h1${id ? ' class="id"' : ""}>${esc(title)}</h1>
   </div>`;

export const section = (label: string, inner: string): string =>
  `<section>${label ? `<h2>${esc(label)}</h2>` : ""}${inner}</section>`;

/** A card. `meta` sits right-aligned in the header for context, not decoration. */
export const card = (title: string, body: string, meta = "", flush = false): string =>
  `<div class="card">
     ${title ? `<div class="card-hd"><h3>${esc(title)}</h3>${meta ? `<span class="meta">${meta}</span>` : ""}</div>` : ""}
     <div class="card-bd${flush ? " flush" : ""}">${body}</div>
   </div>`;

export type StatTone = "hero" | "normal" | "quiet";

/**
 * A label and a figure. There is deliberately nowhere to put a caption.
 *
 * The sub-line these boxes used to carry drifted into commentary — half of
 * them restated the label. Where a second number genuinely mattered it now
 * gets a box of its own, which is also how it becomes comparable.
 */
export const stat = (label: string, value: string, tone: StatTone = "normal"): string =>
  `<div class="stat${tone === "hero" ? " hero" : tone === "quiet" ? " quiet" : ""}">
     <div class="k">${esc(label)}</div>
     <div class="v">${esc(value)}</div>
   </div>`;

export const grid = (cols: 2 | 3 | 4, items: string[]): string =>
  `<div class="grid c${cols}">${items.join("")}</div>`;

/** SIM or LIVE. The case trail exists to prove the honesty claim, so every
 *  executed row has to say which world it happened in. */
export const surfaceTag = (surface: string): string =>
  surface === "live"
    ? `<span class="chip solid">LIVE</span>`
    : `<span class="chip">SIM</span>`;

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

/**
 * A terminal block, for the surfaces that are machine output rather than prose:
 * the estimator, the policy file, an incident's root cause, the live log.
 *
 * Inverting them is the design system's own move for a surface that should not
 * read as a document, and it draws the line between what the console is saying
 * and what it is quoting verbatim.
 */
export const term = (label: string, body: string): string =>
  `<div class="term">
     <div class="term-hd"><span class="caret"></span>${esc(label)}</div>
     <div class="term-bd">${body}</div>
   </div>`;

export const empty = (what: string): string => `<p class="empty">${what}</p>`;
