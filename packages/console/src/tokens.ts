/**
 * Monochrome, but structured.
 *
 * The previous pass removed every container, and a screen with no containment
 * gives the eye nowhere to rest — everything sits on one plane and scanning
 * becomes reading. This restores grouping without going back to a page of
 * identical boxes: cards carry a hairline and a raised surface, sections carry
 * a heading outside the card, and only the figure that matters is large.
 *
 * Still black and white. State is weight and rule, never hue.
 */
export const CSS = `
:root{
  --bg:#FAFAFA;
  --card:#FFFFFF;
  --card-alt:#F6F6F6;
  --border:#E7E7E7;
  --border-mid:#D6D6D6;
  --border-strong:#111111;
  --ink:#111111;
  --ink-2:#5B5B5B;
  --ink-3:#8C8C8C;
  --ink-4:#B5B5B5;
  --shadow:0 1px 2px rgba(0,0,0,.04);
  --r:10px;
  --r-sm:6px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0A0A0A;
    --card:#151515;
    --card-alt:#1C1C1C;
    --border:#262626;
    --border-mid:#333333;
    --border-strong:#F2F2F2;
    --ink:#F2F2F2;
    --ink-2:#A8A8A8;
    --ink-3:#7A7A7A;
    --ink-4:#4F4F4F;
    --shadow:none;
  }
}
:root[data-theme="dark"]{
  --bg:#0A0A0A; --card:#151515; --card-alt:#1C1C1C;
  --border:#262626; --border-mid:#333333; --border-strong:#F2F2F2;
  --ink:#F2F2F2; --ink-2:#A8A8A8; --ink-3:#7A7A7A; --ink-4:#4F4F4F;
  --shadow:none;
}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  font-size:14px;line-height:1.55;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
a{color:inherit;text-decoration:none}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:3px}
.mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-variant-numeric:tabular-nums}
code{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;font-size:.9em}

/* ── shell ────────────────────────────────────────────────────────────── */
.shell{display:grid;grid-template-columns:216px minmax(0,1fr);min-height:100vh}

aside{
  border-right:1px solid var(--border);background:var(--card);
  padding:22px 0 24px;position:sticky;top:0;height:100vh;overflow-y:auto;
  display:flex;flex-direction:column;
}
.brand{padding:0 20px 20px;border-bottom:1px solid var(--border);margin-bottom:16px}
.brand b{display:block;font-size:14px;font-weight:620;letter-spacing:-.01em}
.brand span{display:block;font-size:11px;color:var(--ink-3);margin-top:2px;line-height:1.4}

.navgroup{padding:0 12px;margin-bottom:16px}
.navgroup h3{
  font-size:10px;font-weight:500;letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-4);margin:0 0 6px;padding:0 8px;
}
aside nav{display:flex;flex-direction:column;gap:1px}
aside nav a{
  padding:6px 10px;border-radius:var(--r-sm);font-size:13.5px;color:var(--ink-2);
  display:flex;justify-content:space-between;align-items:center;gap:8px;
}
aside nav a:hover{background:var(--card-alt);color:var(--ink)}
aside nav a.on{background:var(--card-alt);color:var(--ink);font-weight:560}
aside nav a .badge{font-size:11px;color:var(--ink-4);font-family:ui-monospace,Menlo,monospace}
.sidefoot{margin-top:auto;padding:14px 20px 0;border-top:1px solid var(--border);
  font-size:11.5px;color:var(--ink-3);line-height:1.5}

main{padding:30px 34px 80px;max-width:1180px}
@media (max-width:860px){
  .shell{grid-template-columns:1fr}
  aside{position:static;height:auto;border-right:none;border-bottom:1px solid var(--border)}
  .navgroup{display:inline-block;margin-bottom:8px}
  aside nav{flex-direction:row;flex-wrap:wrap}
  main{padding:22px 18px 60px}
}

/* ── page head ────────────────────────────────────────────────────────── */
.pagehead{margin-bottom:26px}
.pagehead h1{font-size:23px;font-weight:620;letter-spacing:-.02em;margin:0 0 5px;
  line-height:1.2;text-wrap:balance}
.pagehead p{margin:0;color:var(--ink-3);font-size:13.5px;max-width:70ch}

h2{font-size:12px;font-weight:560;letter-spacing:.02em;color:var(--ink-2);
  margin:0 0 10px}
section{margin-bottom:26px}
p{margin:0 0 12px;max-width:72ch}
.note{color:var(--ink-2);font-size:13px;max-width:72ch;margin:0}
.hint{color:var(--ink-3);font-size:12.5px;max-width:74ch;margin:12px 0 0}

/* ── cards ────────────────────────────────────────────────────────────── */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);
  box-shadow:var(--shadow);overflow:hidden}
.card + .card{margin-top:14px}
.card-hd{padding:13px 18px;border-bottom:1px solid var(--border);
  display:flex;justify-content:space-between;align-items:center;gap:14px}
.card-hd h3{font-size:12.5px;font-weight:580;margin:0;letter-spacing:-.005em}
.card-hd .meta{font-size:11.5px;color:var(--ink-3)}
.card-bd{padding:16px 18px}
.card-bd.flush{padding:0}
.card-bd.flush table{margin:0}

.grid{display:grid;gap:14px}
.grid.c2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.grid.c3{grid-template-columns:repeat(auto-fit,minmax(215px,1fr))}
.grid.c4{grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}

/* ── stats ────────────────────────────────────────────────────────────── */
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--r);
  padding:15px 17px;box-shadow:var(--shadow)}
.stat .k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);
  margin-bottom:8px}
.stat .v{font-size:24px;font-weight:600;letter-spacing:-.028em;line-height:1.1;
  font-variant-numeric:tabular-nums}
.stat .s{font-size:12px;color:var(--ink-3);margin-top:6px;line-height:1.45}
.stat.hero{border-color:var(--border-strong);border-width:1.5px}
.stat.hero .v{font-size:33px}
.stat.quiet .v{color:var(--ink-3);font-weight:500}

/* ── tables ───────────────────────────────────────────────────────────── */
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{
  font-size:10.5px;font-weight:520;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-3);text-align:left;padding:10px 16px;background:var(--card-alt);
  border-bottom:1px solid var(--border);white-space:nowrap;
}
tbody td{padding:11px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--card-alt)}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;white-space:nowrap}
td.key{font-weight:560}
td a{border-bottom:1px solid var(--ink-4)}
td a:hover{border-bottom-color:var(--ink)}

/* ── chips ────────────────────────────────────────────────────────────── */
.chip{display:inline-block;font-size:10.5px;letter-spacing:.05em;padding:2px 7px;
  border:1px solid var(--border-mid);border-radius:999px;color:var(--ink-2);
  white-space:nowrap;font-family:ui-monospace,Menlo,monospace}
.chip.solid{background:var(--ink);color:var(--bg);border-color:var(--ink);font-weight:600}
.chip.on{border-color:var(--ink);color:var(--ink)}
.filters{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px}
.filters a{font-size:12.5px;padding:4px 11px;border:1px solid var(--border);
  border-radius:999px;color:var(--ink-2);background:var(--card)}
.filters a:hover{border-color:var(--border-mid);color:var(--ink)}
.filters a.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}

.state{font-size:11.5px;white-space:nowrap}
.state-RECOVERED{font-weight:620}
.state-UNRECOVERABLE,.state-DISPUTED,.state-OPTED_OUT,
.state-STOPPED_HUMAN,.state-SUPPRESSED_BY_INCIDENT{color:var(--ink-3)}

/* ── bars ─────────────────────────────────────────────────────────────── */
.bar{height:4px;background:var(--border);border-radius:999px;min-width:60px;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--ink);border-radius:999px}
.bar.quiet>span{background:var(--ink-4)}

/* ── trail ────────────────────────────────────────────────────────────── */
.trail{font-size:12.5px}
.trail td{padding:8px 16px;border-bottom:1px solid var(--border);vertical-align:baseline}
.trail td.t{color:var(--ink-3);white-space:nowrap;width:76px;
  font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.trail td.ev{white-space:nowrap;width:140px;font-size:10.5px;letter-spacing:.07em;
  text-transform:uppercase;color:var(--ink-3)}
.trail tr.key td{background:var(--card-alt)}
.trail tr.key td.ev{color:var(--ink);font-weight:620}
.trail td.d{color:var(--ink-2);line-height:1.5}

pre{margin:0;white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-size:12px;line-height:1.7;color:var(--ink-2)}
.quote{border-left:2px solid var(--ink);padding-left:15px;margin:0;
  font-size:14px;color:var(--ink-2);max-width:62ch}

#stream{height:calc(100vh - 250px);overflow-y:auto;
  font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  font-size:12px;line-height:1.8;padding:14px 18px}
#stream div{white-space:pre;color:var(--ink-2)}
#stream div b{font-weight:620;color:var(--ink)}
.empty{color:var(--ink-3);font-size:13px;padding:22px 18px;text-align:center}
`;
