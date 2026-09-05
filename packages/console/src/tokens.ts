/**
 * The console, dressed in the design system in design.md.
 *
 * Three things carry that system and everything else follows from them:
 *
 *   1. Warm neutrals, not greys. The canvas is off-white #f5f5f5 over warm
 *      near-black ink #0c0a09. Hue is never information — it is temperature.
 *      Light only: the system is built on an off-white paper canvas, and an
 *      inverted version of it would be a different design, not a variant.
 *   2. An editorial display face at a light weight. Display copy never bolds;
 *      that single rule is what separates the voice from consumer marketing.
 *      Waldenburg is licensed, so this uses the documented substitute path and
 *      falls back to the system serif — the console must load with no network.
 *   3. Atmosphere instead of accent. There is no saturated action colour. The
 *      five pastel orbs are the only chroma on the page, they sit behind copy,
 *      and they never encode state.
 *
 * Adapted in one place, deliberately: design.md's 96px section rhythm is a
 * marketing rhythm. On a screen carrying a hundred rows of evidence it would
 * scroll the argument apart, so bands sit at 40px and the editorial breathing
 * is spent on the page head instead, where the reader actually pauses.
 */
export const CSS = `
:root{
  /* surface */
  --canvas:#f5f5f5;
  --canvas-soft:#fafafa;
  --card:#ffffff;
  --surface-strong:#f0efed;
  /* hairlines */
  --line:#e7e5e4;
  --line-soft:#f0efed;
  --line-strong:#d6d3d1;
  /* ink */
  --ink:#0c0a09;
  --body:#4e4e4e;
  --muted:#777169;
  --muted-soft:#a8a29e;
  --on-ink:#ffffff;
  /* atmosphere — decoration only, never state */
  --orb-mint:#a7e5d3;
  --orb-peach:#f4c5a8;
  --orb-lavender:#c8b8e0;
  --orb-sky:#a8c8e8;
  --orb-rose:#e8b8c4;
  --orb:var(--orb-mint);
  --orb-opacity:.5;
  /* shape + depth */
  --r-sm:6px; --r-md:8px; --r-lg:12px; --r-xl:16px; --r-xxl:24px; --pill:9999px;
  --drop:0 4px 16px rgba(12,10,9,.04);
  --serif:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
  --sans:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
}
/* per-screen atmosphere: one orb, chosen by route, purely decorative */
[data-orb="peach"]{--orb:var(--orb-peach)}
[data-orb="lavender"]{--orb:var(--orb-lavender)}
[data-orb="sky"]{--orb:var(--orb-sky)}
[data-orb="rose"]{--orb:var(--orb-rose)}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light}
body{
  margin:0;background:var(--canvas);color:var(--body);
  font-family:var(--sans);font-size:15px;line-height:1.5;letter-spacing:.16px;
  font-weight:400;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
a{color:inherit;text-decoration:none}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:var(--r-xs,4px)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:0}
code{font-family:var(--mono);font-size:.88em;letter-spacing:0}

/* ── shell ────────────────────────────────────────────────────────────── */
.shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}

aside{
  border-right:1px solid var(--line);background:var(--canvas-soft);
  padding:26px 0 26px;position:sticky;top:0;height:100vh;overflow-y:auto;
  display:flex;flex-direction:column;
}
.brand{padding:0 22px 22px;border-bottom:1px solid var(--line);margin-bottom:20px}
.brand b{display:block;font-family:var(--serif);font-weight:300;font-size:21px;
  letter-spacing:-.21px;color:var(--ink);line-height:1.2}
.brand span{display:block;font-size:12px;color:var(--muted);margin-top:5px;line-height:1.45}

.navgroup{padding:0 12px;margin-bottom:20px}
.navgroup h3{
  font-size:12px;font-weight:600;letter-spacing:.96px;text-transform:uppercase;
  color:var(--muted-soft);margin:0 0 8px;padding:0 10px;
}
aside nav{display:flex;flex-direction:column;gap:2px}
aside nav a{
  padding:7px 12px;border-radius:var(--pill);font-size:15px;font-weight:500;color:var(--body);
  display:flex;justify-content:space-between;align-items:center;gap:8px;
}
aside nav a:hover{background:var(--surface-strong);color:var(--ink)}
aside nav a.on{background:var(--ink);color:var(--on-ink)}
.sidefoot{margin-top:auto;padding:18px 22px 0;border-top:1px solid var(--line);
  font-size:13px;color:var(--muted);line-height:1.5}

main{padding:0 40px 96px;max-width:1200px}
@media (max-width:860px){
  .shell{grid-template-columns:1fr}
  aside{position:static;height:auto;border-right:none;border-bottom:1px solid var(--line)}
  .navgroup{display:inline-block;margin-bottom:10px}
  aside nav{flex-direction:row;flex-wrap:wrap}
  main{padding:0 20px 64px}
}

/* ── page head — where the editorial breathing is spent ───────────────── */
.pagehead{position:relative;padding:56px 0 6px;isolation:isolate}
.orb{
  position:absolute;z-index:-1;top:-90px;right:-40px;width:440px;height:340px;
  background:radial-gradient(closest-side,var(--orb),transparent 72%);
  opacity:var(--orb-opacity);filter:blur(26px);pointer-events:none;
}
@media (max-width:860px){.orb{width:280px;height:230px;right:-70px}}
.pagehead h1{
  font-family:var(--serif);font-weight:300;font-size:48px;line-height:1.08;
  letter-spacing:-.96px;color:var(--ink);margin:0 0 12px;text-wrap:balance;
}
.pagehead p{margin:0;color:var(--muted);font-size:16px;max-width:66ch;letter-spacing:.16px}
.pagehead h1.id{font-family:var(--mono);font-weight:400;font-size:30px;letter-spacing:-.6px}
@media (max-width:640px){.pagehead h1{font-size:32px;letter-spacing:-.32px}
  .pagehead h1.id{font-size:22px}}

h2{font-family:var(--serif);font-weight:300;font-size:24px;line-height:1.2;
  color:var(--ink);margin:0 0 18px;letter-spacing:0}
h2.mono{font-family:var(--mono);font-size:19px;font-weight:500;letter-spacing:-.2px}
section{margin:52px 0 0}
section:first-of-type{margin-top:44px}
.grid + .grid{margin-top:16px}
main > .grid:first-of-type{margin-top:22px}
p{margin:0 0 14px;max-width:70ch}
.note{color:var(--body);font-size:15px;max-width:70ch;margin:0}

/* ── cards — hairline + one soft drop tier ────────────────────────────── */
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-xl);
  overflow:hidden;transition:box-shadow .18s ease}
.card:hover{box-shadow:var(--drop)}
.card + .card{margin-top:16px}
.card-hd{padding:18px 24px;border-bottom:1px solid var(--line-soft);
  display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.card-hd h3{font-size:18px;font-weight:500;margin:0;color:var(--ink);letter-spacing:.18px}
.card-hd .meta{font-size:14px;color:var(--muted);letter-spacing:0}
.card-bd{padding:20px 24px}
.card-bd.flush{padding:0}
.card-bd.flush table{margin:0}

.grid{display:grid;gap:16px}
.grid.c2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.grid.c3{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.grid.c4{grid-template-columns:repeat(auto-fit,minmax(186px,1fr))}

/* ── stats — the display face carries the figure, never a bold weight ─── */
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--r-xl);
  padding:20px 22px;transition:box-shadow .18s ease}
.stat:hover{box-shadow:var(--drop)}
.stat .k{font-size:12px;font-weight:600;letter-spacing:.96px;text-transform:uppercase;
  color:var(--muted);margin-bottom:14px}
.stat .v{font-family:var(--serif);font-weight:300;font-size:32px;letter-spacing:-.32px;
  line-height:1.13;color:var(--ink);font-variant-numeric:tabular-nums}
.stat.hero{border-color:var(--ink)}
.stat.hero .v{font-size:44px;letter-spacing:-.88px;line-height:1.05}
.stat.quiet .v{color:var(--muted)}

/* ── tables ───────────────────────────────────────────────────────────── */
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:15px}
thead th{
  font-size:12px;font-weight:600;letter-spacing:.96px;text-transform:uppercase;
  color:var(--muted);text-align:left;padding:12px 24px;background:var(--canvas-soft);
  border-bottom:1px solid var(--line);white-space:nowrap;
}
tbody td{padding:13px 24px;border-bottom:1px solid var(--line-soft);vertical-align:middle;
  color:var(--body)}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--canvas-soft)}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums;
  font-family:var(--mono);font-size:14px;letter-spacing:0;white-space:nowrap}
td.key{font-weight:500;color:var(--ink)}
td a{border-bottom:1px solid var(--line-strong)}
td a:hover{border-bottom-color:var(--ink)}

/* ── pills — the brand shape, for every badge and filter ──────────────── */
.chip{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.96px;
  text-transform:uppercase;padding:4px 10px;background:var(--surface-strong);
  border-radius:var(--pill);color:var(--ink);white-space:nowrap}
.chip.solid{background:var(--ink);color:var(--on-ink)}
.chip.on{background:var(--ink);color:var(--on-ink)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.filters a{font-size:15px;font-weight:500;padding:8px 18px;border:1px solid var(--line-strong);
  border-radius:var(--pill);color:var(--ink);background:transparent;line-height:1}
.filters a:hover{background:var(--surface-strong)}
.filters a.on{background:var(--ink);color:var(--on-ink);border-color:var(--ink)}

.state{font-size:15px;white-space:nowrap}
.state-RECOVERED{color:var(--ink);font-weight:500}
.state-UNRECOVERABLE,.state-DISPUTED,.state-OPTED_OUT,
.state-STOPPED_HUMAN,.state-SUPPRESSED_BY_INCIDENT{color:var(--muted)}

/* ── bars ─────────────────────────────────────────────────────────────── */
.bar{height:4px;background:var(--surface-strong);border-radius:var(--pill);
  width:132px;min-width:132px;overflow:hidden}
td:has(> .bar){width:132px}
.bar>span{display:block;height:100%;background:var(--ink);border-radius:var(--pill)}
.bar.quiet>span{background:var(--muted-soft)}

/* ── trail ────────────────────────────────────────────────────────────── */
.trail{font-size:15px}
.trail td{padding:10px 24px;border-bottom:1px solid var(--line-soft);vertical-align:baseline}
.trail td.t{color:var(--muted-soft);white-space:nowrap;width:84px;
  font-family:var(--mono);font-size:13px;letter-spacing:0}
.trail td.ev{white-space:nowrap;width:156px;font-size:12px;font-weight:600;letter-spacing:.96px;
  text-transform:uppercase;color:var(--muted)}
.trail tr.key td{background:var(--canvas-soft)}
.trail tr.key td.ev{color:var(--ink)}
.trail td.d{color:var(--body);line-height:1.5}

.term{background:#0c0a09;border-radius:var(--r-xl);overflow:hidden;
  border:1px solid #0c0a09}
.term-hd{display:flex;align-items:center;gap:9px;padding:12px 18px;
  border-bottom:1px solid #262220;font-family:var(--mono);font-size:12px;
  letter-spacing:.96px;text-transform:uppercase;color:#a8a29e}
.term-hd .caret{width:7px;height:13px;background:#a8a29e;display:inline-block;
  animation:blink 1.2s step-end infinite}
@keyframes blink{50%{opacity:0}}
.term-bd{padding:18px 20px;overflow-x:auto;max-height:560px;overflow-y:auto}
.term-bd:has(> #stream){max-height:none;overflow:hidden}
.term-bd pre{color:#d8d4d0}
.term-bd pre b,.term-bd pre strong{color:#faf9f8}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);
  font-size:13px;line-height:1.75;color:var(--body);letter-spacing:0}
.quote{border-left:2px solid var(--line-strong);padding-left:18px;margin:0;
  font-family:var(--serif);font-weight:300;font-size:20px;line-height:1.4;
  color:var(--ink);max-width:60ch}

#stream{height:calc(100vh - 300px);overflow-y:auto;font-family:var(--mono);
  font-size:13px;line-height:1.85;letter-spacing:0}
#stream div{white-space:pre;color:#d8d4d0}
#stream div b{font-weight:600;color:#faf9f8}
.empty{color:var(--muted);font-size:15px;padding:28px 24px;text-align:center}
`;
