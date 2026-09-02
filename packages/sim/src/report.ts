import type { BatchReport } from "./runner.js";

const rupees = (paise: number): string => {
  const r = paise / 100;
  if (r >= 1e7) return `₹ ${(r / 1e7).toFixed(2)} Cr`;
  if (r >= 1e5) return `₹ ${(r / 1e5).toFixed(2)} L`;
  return `₹ ${r.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, n: number): string => s.padEnd(n);
const lpad = (s: string, n: number): string => s.padStart(n);

/**
 * The batch run screen, as text.
 *
 * Gross and incremental sit side by side and are never conflated. Ground truth
 * is printed next to the estimate with the error between them — the line no
 * team using production data can show, because they do not know who would have
 * paid anyway.
 */
export function renderReport(r: BatchReport): string {
  const a = r.attribution;
  const L = 68;
  const line = (s = "") => `│ ${pad(s, L)} │`;
  const rule = `├${"─".repeat(L + 2)}┤`;

  const out: string[] = [];
  out.push(`┌─ RUN ${r.batchId} ${"─".repeat(Math.max(0, L - 6 - r.batchId.length - 9))} COMPLETE ─┐`);
  out.push(line());
  out.push(line(`  ${lpad(rupees(a.grossRecoveredPaise), 14)}  ${lpad(rupees(a.incrementalPaise), 14)}  ${lpad(rupees(r.trueIncrementalPaise), 14)}  ${lpad(pct(r.estimationError), 7)}`));
  out.push(line(`  ${pad("GROSS", 14)}  ${pad("EST. INCREMENTAL", 14)}  ${pad("TRUE (SIM)", 14)}  ${pad("ERROR", 7)}`));
  out.push(line(`  ${pad("", 14)}  ${pad(`95% CI ${rupees(a.incrementalCi[0])}–${rupees(a.incrementalCi[1])}`, 32)}`));
  out.push(line());
  out.push(line(`  interval contains ground truth: ${r.intervalContainsTruth ? "YES" : "NO"}`));
  out.push(line(`  value-band stratified (diagnostic): ${rupees(a.incrementalStratifiedPaise)}`));
  out.push(line());
  out.push(line(`  treated ${lpad(String(a.treatedN), 5)}   rate ${pct(a.treatedRate)}   recovered ${a.treatedRecovered}`));
  out.push(line(`  holdout ${lpad(String(a.holdoutN), 5)}   rate ${pct(a.holdoutRate)}   recovered ${a.holdoutRecovered}`));
  out.push(line(`  lift    ${pct(a.lift)}   95% CI ${pct(a.liftCi[0])} – ${pct(a.liftCi[1])}`));
  out.push(line(`  excluded (natural recovery, both arms): treated ${a.excludedTreated}, holdout ${a.excludedHoldout}`));
  out.push(rule);
  out.push(line(`  TIER            cases    │  TERMINAL STATE          cases`));
  const terminals = Object.entries(r.terminalStates).sort((x, y) => y[1] - x[1]);
  const tiers = [
    ["T0 resolved", r.tier0Resolved],
    ["T1 escalated", r.tier1Escalated],
    ["provider calls", r.providerCalls],
    ["degraded escal.", r.degradedEscalations],
    ["actions executed", r.actionsExecuted],
  ] as const;
  for (let i = 0; i < Math.max(tiers.length, terminals.length); i++) {
    const t = tiers[i];
    const s = terminals[i];
    const left = t ? `  ── ${pad(t[0], 16)} ${lpad(String(t[1]), 5)}` : " ".repeat(26);
    const right = s ? `  ${pad(s[0], 22)} ${lpad(String(s[1]), 5)}` : "";
    out.push(line(`${pad(left, 28)}│${right}`));
  }
  if (r.stepErrors > 0) {
    out.push(rule);
    out.push(line(`  step errors: ${r.stepErrors}`));
    for (const e of r.errorSamples) out.push(line(`    ${e.slice(0, L - 6)}`));
  }
  const blocks = Object.entries(r.policyBlocks);
  if (blocks.length) {
    out.push(rule);
    for (const [rule_, n] of blocks) out.push(line(`  policy ${rule_} blocked ${n} action(s)`));
  }
  out.push(`└${"─".repeat(L + 2)}┘`);
  return out.join("\n");
}

/** Side-by-side ablation: what parallel deliberation actually contributed. */
export function renderAblation(full: BatchReport, control: BatchReport): string {
  const delta = full.attribution.incrementalPaise - control.attribution.incrementalPaise;
  if (full.providerCalls === 0) {
    return [
      "ABLATION — NOT MEANINGFUL: no provider was configured.",
      "",
      `  The full arm made ${full.providerCalls} provider calls, so its Tier 1 cases ran in`,
      `  degraded mode and escalated (${full.degradedEscalations} cases) instead of being`,
      "  diagnosed. Comparing that against the Tier 0 control measures the",
      "  degraded-mode safety rule, not deliberation.",
      "",
      "  Set OPENAI_API_KEY and re-run to measure the model's contribution.",
    ].join("\n");
  }
  return [
    "ABLATION — same seed, same world, deliberation on vs off",
    `  full runtime      incremental ${rupees(full.attribution.incrementalPaise)}   lift ${pct(full.attribution.lift)}   provider calls ${full.providerCalls}`,
    `  tier-0 control    incremental ${rupees(control.attribution.incrementalPaise)}   lift ${pct(control.attribution.lift)}   provider calls ${control.providerCalls}`,
    `  attributable to deliberation: ${rupees(delta)}`,
    "",
    "  The control uses a generic per-rail playbook rather than stopping, so the",
    "  delta measures deliberation and not the degraded-mode safety rule.",
  ].join("\n");
}
