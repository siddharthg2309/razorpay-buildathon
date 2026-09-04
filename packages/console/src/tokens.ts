/**
 * Monochrome, typographic, no chrome.
 *
 * The screens carry dense numbers and decision trails, and the earlier version
 * put every group in a bordered card — which reads as a dashboard template and
 * makes everything look equally important. Here the hierarchy is type and
 * whitespace instead: one hairline where a division is real, generous space
 * where it is not, and size reserved for the number that matters.
 *
 * Black and white only. State is carried by weight and rule, not colour, so
 * nothing depends on hue to be legible.
 */
export const CSS = `
:root{
  --paper:#FFFFFF;
  --ink:#0A0A0A;
  --ink-70:#4A4A4A;
  --ink-45:#767676;
  --ink-20:#B8B8B8;
  --rule:#E4E4E4;
  --rule-strong:#0A0A0A;
  --wash:#F7F7F7;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#0B0B0B;
    --ink:#F5F5F5;
    --ink-70:#B4B4B4;
    --ink-45:#8A8A8A;
    --ink-20:#4A4A4A;
    --rule:#242424;
    --rule-strong:#F5F5F5;
    --wash:#141414;
  }
}
:root[data-theme="dark"]{
  --paper:#0B0B0B;
  --ink:#F5F5F5;
  --ink-70:#B4B4B4;
  --ink-45:#8A8A8A;
  --ink-20:#4A4A4A;
  --rule:#242424;
  --rule-strong:#F5F5F5;
  --wash:#141414;
}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:var(--paper);
  color:var(--ink);
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  font-size:15px;
  line-height:1.6;
  font-feature-settings:"kern" 1,"liga" 1;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
a{color:inherit;text-decoration:none;border-bottom:1px solid var(--ink-20)}
a:hover{border-bottom-color:var(--ink)}
a:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-bottom-color:transparent}

/* ── masthead ─────────────────────────────────────────────────────────── */
.masthead{
  border-bottom:1px solid var(--rule-strong);
  padding:26px 40px 18px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:32px;flex-wrap:wrap;
}
.wordmark{
  font-size:15px;font-weight:640;letter-spacing:-.015em;
}
.wordmark span{display:block;font-size:11px;font-weight:400;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink-45);margin-top:3px}
nav{display:flex;gap:26px;flex-wrap:wrap}
nav a{
  border-bottom:none;font-size:12.5px;letter-spacing:.04em;color:var(--ink-45);
  padding-bottom:2px;
}
nav a:hover{color:var(--ink)}
nav a.on{color:var(--ink);box-shadow:inset 0 -1px 0 0 var(--ink)}

main{padding:44px 40px 96px;max-width:1120px}
@media (max-width:640px){
  .masthead{padding:20px 20px 14px}
  main{padding:30px 20px 64px}
}

/* ── type ─────────────────────────────────────────────────────────────── */
h1{
  font-size:clamp(24px,3.4vw,32px);font-weight:600;letter-spacing:-.022em;
  line-height:1.15;margin:0 0 6px;text-wrap:balance;
}
.dek{color:var(--ink-45);font-size:14px;margin:0 0 40px;max-width:62ch}
h2{
  font-size:11px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;
  color:var(--ink-45);margin:0 0 18px;padding-bottom:9px;
  border-bottom:1px solid var(--rule);
}
p{margin:0 0 14px;max-width:68ch}
.note{color:var(--ink-45);font-size:13.5px;max-width:68ch;margin:0}
.hint{color:var(--ink-45);font-size:12px;margin-top:26px;max-width:70ch}
section{margin-bottom:56px}
code,.mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-size:.9em;font-variant-numeric:tabular-nums}

/* ── the headline figure ──────────────────────────────────────────────── */
.lede{display:flex;gap:64px;flex-wrap:wrap;align-items:flex-start;margin-bottom:14px}
.figure{min-width:150px}
.figure .amount{
  font-size:clamp(30px,4.6vw,46px);font-weight:600;letter-spacing:-.032em;
  line-height:1;font-variant-numeric:tabular-nums;display:block;
}
.figure .amount.quiet{color:var(--ink-45);font-weight:400}
.figure .caption{
  font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;
  color:var(--ink-45);margin-top:11px;
}
.figure .under{font-size:12.5px;color:var(--ink-70);margin-top:5px;
  font-variant-numeric:tabular-nums}

/* ── measures ─────────────────────────────────────────────────────────── */
.measures{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:28px 40px;margin:0 0 8px}
.measure .v{font-size:21px;font-weight:550;letter-spacing:-.018em;
  font-variant-numeric:tabular-nums;line-height:1.2}
.measure .v.quiet{color:var(--ink-45);font-weight:400}
.measure .k{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink-45);margin-top:7px}
.measure .s{font-size:12.5px;color:var(--ink-70);margin-top:4px}

/* ── tables: baselines only, never a grid ─────────────────────────────── */
.scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
thead th{
  font-size:10px;font-weight:500;letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-45);text-align:left;padding:0 22px 9px 0;
  border-bottom:1px solid var(--rule-strong);white-space:nowrap;
}
tbody td{padding:11px 22px 11px 0;border-bottom:1px solid var(--rule);
  vertical-align:top}
tbody tr:last-child td{border-bottom:none}
th.num,td.num{text-align:right;padding-right:0;font-variant-numeric:tabular-nums;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;white-space:nowrap}
tbody tr:hover td{background:var(--wash)}
td.key{font-weight:520}

/* ── state, carried by weight not hue ─────────────────────────────────── */
.state{font-size:11px;letter-spacing:.09em;text-transform:uppercase;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace}
.state-RECOVERED{color:var(--ink);font-weight:600}
.state-UNRECOVERABLE,.state-DISPUTED{color:var(--ink-45)}
.state-OPTED_OUT,.state-STOPPED_HUMAN{color:var(--ink-45)}
.state-SUPPRESSED_BY_INCIDENT{color:var(--ink-45)}
.state-DETECTED,.state-DIAGNOSING,.state-PLANNING,.state-EXECUTING,
.state-OBSERVING,.state-SCHEDULED{color:var(--ink-70)}

/* ── marks ────────────────────────────────────────────────────────────── */
.mark{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-size:10px;letter-spacing:.1em;padding:2px 6px;border:1px solid var(--ink-20);
  color:var(--ink-45);white-space:nowrap}
.mark.live{border-color:var(--ink);color:var(--ink);font-weight:600}
.mark.on{border-color:var(--ink);color:var(--ink)}

/* ── bars: a single hairline-weight rule ──────────────────────────────── */
.bar{height:2px;background:var(--rule);margin-top:9px;min-width:70px}
.bar>span{display:block;height:100%;background:var(--ink)}
.bar.quiet>span{background:var(--ink-20)}

/* ── the case trail ───────────────────────────────────────────────────── */
.trail{width:100%;font-size:13px}
.trail td{padding:7px 20px 7px 0;border-bottom:none;vertical-align:baseline}
.trail td.t{color:var(--ink-45);white-space:nowrap;width:74px;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:11.5px}
.trail td.ev{white-space:nowrap;width:132px;font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-45)}
.trail tr.key td.ev{color:var(--ink);font-weight:600}
.trail td.d{color:var(--ink-70);line-height:1.5}
.trail tr:hover td{background:var(--wash)}

/* ── equation block ───────────────────────────────────────────────────── */
pre{margin:0;white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-size:12.5px;line-height:1.75;color:var(--ink-70)}
.quote{border-left:2px solid var(--ink);padding-left:18px;margin:0;
  font-size:15px;color:var(--ink-70);max-width:60ch}

/* ── stream ───────────────────────────────────────────────────────────── */
#stream{height:calc(100vh - 230px);overflow-y:auto;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-size:12px;line-height:1.85;border-top:1px solid var(--rule-strong);
  padding-top:14px}
#stream div{white-space:pre;color:var(--ink-70)}
#stream div b{font-weight:600;color:var(--ink)}
.empty{color:var(--ink-45);font-size:13.5px;padding:26px 0}
`;
