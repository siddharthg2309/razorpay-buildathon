/**
 * Does the suite actually catch regressions?
 *
 * A green suite proves the tests pass, not that they would notice if the
 * product broke. This breaks specific safety properties on purpose, runs the
 * tests that claim to guard them, and reports any mutation that survives.
 *
 * A survivor is not a failing test — it is a property nobody is checking.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface Mutation {
  name: string;
  /** The property that should stop this from shipping. */
  guards: string;
  file: string;
  from: string;
  to: string;
  /** Suites expected to catch it. Narrowed so each run is quick. */
  suites: string[];
}

const MUTATIONS: Mutation[] = [
  {
    name: "quiet hours never block",
    guards: "no customer is contacted outside permitted hours",
    file: "packages/core/src/policy.ts",
    from: "return start > end ? now >= start || now < end : now >= start && now < end;",
    to: "return false;",
    suites: ["tests/policy.test.ts", "tests/sim.test.ts"],
  },
  {
    name: "capability tokens are never burned",
    guards: "a token cannot be replayed to act twice",
    file: "packages/engine/src/token-burn.ts",
    from: 'if ((err as { code?: string }).code === "23505") throw new TokenReplayError(token.nonce);',
    to: "if (false) throw new TokenReplayError(token.nonce);",
    suites: ["tests/policy.test.ts", "tests/executor.test.ts"],
  },
  {
    name: "terminal states stop cancelling scheduled work",
    guards: "a recovered case stops being chased",
    file: "packages/db/src/case-events.ts",
    from: "if (isTerminal(revision.state)) {",
    to: "if (false && isTerminal(revision.state)) {",
    suites: ["tests/scheduler.test.ts", "tests/verifier.test.ts"],
  },
  {
    name: "hard declines become retryable",
    guards: "a revoked mandate is never retried",
    file: "packages/core/src/taxonomy.ts",
    from: "retryPermitted: entry.retryEligible && attemptNo < entry.retryCeiling,",
    to: "retryPermitted: true,",
    suites: ["tests/tier0.test.ts", "tests/mandate-sequencer.test.ts"],
  },
  {
    name: "natural recovery is excluded from the treated arm only",
    guards: "the headline number is not inflated by one-sided exclusion",
    file: "packages/attribution/src/estimator.ts",
    from: "const excludedHoldout = outcomes.filter((o) => o.holdout && isExcluded(o, config)).length;",
    to: "const excludedHoldout = 0;",
    suites: ["tests/attribution.test.ts"],
  },
  {
    name: "webhook signatures always verify",
    guards: "a forged provider event cannot open a case",
    file: "packages/connectors/src/webhook.ts",
    from: "return expected.length === actual.length && timingSafeEqual(expected, actual);",
    to: "return true;",
    suites: ["tests/hardening.test.ts"],
  },
  {
    name: "the reducer ignores opt-out precedence",
    guards: "a customer signal outranks machine inference",
    file: "packages/agents/src/reducer.ts",
    from: 'if (context.optedOut || context.intent === "opt_out") {',
    to: "if (false) {",
    suites: ["tests/agents.test.ts", "tests/intent-checkout.test.ts"],
  },
  {
    name: "the optimizer may select actions outside the library",
    guards: "the agent cannot invent an action",
    file: "packages/agents/src/optimizer.ts",
    from: "action = this.library.get(cand.actionId);",
    to: "action = this.library.get(cand.actionId) ?? ({} as never);",
    suites: ["tests/agents.test.ts"],
  },
  {
    name: "holdout assignment ignores the seed",
    guards: "the split is reproducible",
    file: "packages/attribution/src/holdout.ts",
    from: "const digest = createHash(\"sha256\").update(`${seed}|${stratum}|${input.caseId}`).digest();",
    to: 'const digest = createHash("sha256").update(`${stratum}|${input.caseId}`).digest();',
    suites: ["tests/attribution.test.ts"],
  },
  {
    name: "RECOVERED no longer requires matched money",
    guards: "a delivered message cannot count as a recovery",
    file: "packages/engine/src/verifier.ts",
    from: "if (settled < owed) {",
    to: "if (false) {",
    suites: ["tests/verifier.test.ts"],
  },
];

const only = process.argv[2];
const chosen = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS;

let caught = 0;
const survivors: Mutation[] = [];

console.log(`mutation check — ${chosen.length} deliberate breakages\n`);

for (const m of chosen) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`  SKIP  ${m.name}`);
    console.log(`        anchor no longer present in ${m.file} — the mutation needs updating`);
    survivors.push(m);
    continue;
  }

  writeFileSync(m.file, original.replace(m.from, m.to));
  let failed = false;
  try {
    execSync(`npx vitest run ${m.suites.join(" ")} --silent`, { stdio: "pipe" });
  } catch {
    failed = true; // the suite noticed
  } finally {
    writeFileSync(m.file, original);
  }

  if (failed) {
    caught++;
    console.log(`  caught  ${m.name}`);
  } else {
    survivors.push(m);
    console.log(`  SURVIVED  ${m.name}`);
    console.log(`            unguarded: ${m.guards}`);
  }
}

console.log(`\n${caught}/${chosen.length} caught`);
if (survivors.length) {
  console.log("\nEach survivor is a safety property the suite does not actually check:");
  for (const s of survivors) console.log(`  - ${s.guards}`);
  process.exit(1);
}
console.log("Every deliberate breakage was caught.");
