/**
 * Design tokens from build-plan §4a: clean, classic, monospace, boxed.
 *
 * An instrument panel, not a marketing page — which is also the right register
 * for the content: dense numbers, state machines, audit trails. One accent
 * colour, used only to mark the thing worth looking at.
 */
export const CSS = `
:root {
  --bg:#FAF9F6; --panel:#FFFFFF;
  --ink:#14120F; --ink-2:#55504A; --ink-3:#8A847C;
  --rule:#DDD8D0; --accent:#B8862F;
  --ok:#2E6F4E; --warn:#A8641B; --err:#9B2C2C; --held:#4A5B8C;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0F0E0C; --panel:#17150F;
    --ink:#F2EDE3; --ink-2:#A9A196; --ink-3:#6E675E;
    --rule:#2A2620; --accent:#D8A64A;
    --ok:#6FBF8F; --warn:#D9A257; --err:#E08585; --held:#8B9BD0;
  }
}
:root[data-theme="dark"] {
  --bg:#0F0E0C; --panel:#17150F;
  --ink:#F2EDE3; --ink-2:#A9A196; --ink-3:#6E675E;
  --rule:#2A2620; --accent:#D8A64A;
  --ok:#6FBF8F; --warn:#D9A257; --err:#E08585; --held:#8B9BD0;
}

* { box-sizing: border-box; }
body {
  margin:0; background:var(--bg); color:var(--ink);
  font-family: "IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size:13px; line-height:1.55; font-variant-numeric: tabular-nums;
}
a { color:inherit; text-decoration:none; }
a:hover, a:focus-visible { color:var(--accent); }
a:focus-visible { outline:1px solid var(--accent); outline-offset:2px; }

header.top {
  border-bottom:1px solid var(--rule); padding:14px 22px;
  display:flex; gap:26px; align-items:baseline; flex-wrap:wrap;
}
header.top .brand { color:var(--accent); letter-spacing:.06em; }
header.top nav { display:flex; gap:18px; flex-wrap:wrap; }
header.top nav a.on { color:var(--accent); border-bottom:1px solid var(--accent); }

main { padding:22px; max-width:1180px; }
h1 { font-size:15px; font-weight:600; margin:0 0 14px; letter-spacing:.04em; }
h2 { font-size:13px; font-weight:600; margin:22px 0 8px; color:var(--ink-2); letter-spacing:.06em; text-transform:uppercase; }

.panel { border:1px solid var(--rule); background:var(--panel); padding:16px 18px; margin-bottom:16px; }
.panel > .hd { color:var(--ink-3); letter-spacing:.08em; text-transform:uppercase; font-size:11px; margin-bottom:12px; }

.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px; background:var(--rule); border:1px solid var(--rule); }
.kpi { background:var(--panel); padding:14px 16px; }
.kpi .v { font-size:21px; }
.kpi .v.accent { color:var(--accent); }
.kpi .k { color:var(--ink-3); font-size:11px; text-transform:uppercase; letter-spacing:.07em; margin-top:3px; }
.kpi .sub { color:var(--ink-2); font-size:11px; margin-top:5px; }

table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:6px 12px 6px 0; border-bottom:1px solid var(--rule); vertical-align:top; }
th { color:var(--ink-3); font-weight:400; font-size:11px; text-transform:uppercase; letter-spacing:.07em; }
td.num, th.num { text-align:right; padding-right:18px; }
tr:last-child td { border-bottom:none; }

.tag { display:inline-block; padding:0 6px; border:1px solid var(--rule); font-size:10.5px; letter-spacing:.06em; }
.tag.live { color:var(--ok); border-color:var(--ok); }
.tag.sim  { color:var(--held); border-color:var(--held); }
.tag.blocked { color:var(--err); border-color:var(--err); }
.tag.allow { color:var(--ok); border-color:var(--ok); }
.tag.approval { color:var(--warn); border-color:var(--warn); }
.tag.t0 { color:var(--ink-2); }
.tag.t1 { color:var(--accent); border-color:var(--accent); }
.tag.t2 { color:var(--warn); border-color:var(--warn); }

.state-RECOVERED { color:var(--ok); }
.state-UNRECOVERABLE, .state-DISPUTED { color:var(--err); }
.state-OPTED_OUT, .state-STOPPED_HUMAN { color:var(--warn); }
.state-SUPPRESSED_BY_INCIDENT { color:var(--held); }

.trail { width:100%; }
.trail td { padding:5px 12px 5px 0; border-bottom:none; }
.trail td.t { color:var(--ink-3); white-space:nowrap; width:76px; }
.trail td.ev { color:var(--accent); white-space:nowrap; width:120px; letter-spacing:.05em; }
.trail td.d { color:var(--ink); }
.trail td.d .note { color:var(--ink-2); }
.trail tr.sep td { border-top:1px solid var(--rule); padding-top:9px; }

.bar { height:9px; background:var(--rule); position:relative; margin:5px 0; }
.bar > span { display:block; height:100%; background:var(--accent); }
.bar.muted > span { background:var(--ink-3); }

.note { color:var(--ink-2); }
.dim { color:var(--ink-3); }
.mono-sm { font-size:11px; color:var(--ink-3); }
pre { margin:0; white-space:pre-wrap; word-break:break-word; font:inherit; }
.scroll { overflow-x:auto; }
#stream { height:calc(100vh - 190px); overflow-y:auto; border:1px solid var(--rule); background:var(--panel); padding:12px 14px; }
#stream div { white-space:pre; }
.s-DETECT{color:var(--ink-2)} .s-TIER0{color:var(--ink)} .s-TIER1{color:var(--accent)}
.s-CLAIM{color:var(--accent)} .s-POLICY{color:var(--ok)} .s-BLOCK{color:var(--err)}
.s-EXEC{color:var(--ink)} .s-VERIFY{color:var(--ok)} .s-INCIDENT{color:var(--held)}
`;
