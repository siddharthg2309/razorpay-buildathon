/** Returns the database to a known empty state. Must be fast — on stage this
 *  runs between takes, and a slow reset is a dead pause in a five-minute slot.
 *
 *  It refuses while a live case is open. A live case has real provider state
 *  behind it, and wiping the record while the money exists at Razorpay leaves
 *  the payment unmatchable. Pass --force when that is genuinely what you want. */
import { closePool, getPool } from "@rra/db";

const force = process.argv.includes("--force");

const { rows } = await getPool().query<{ id: string }>(
  `SELECT DISTINCT c.id FROM cases c
     JOIN action_attempts a ON a.case_id = c.id
    WHERE a.surface = 'live' AND c.closed_at IS NULL`,
);

if (rows.length > 0 && !force) {
  console.error(`refusing: ${rows.length} open live case(s) with real provider state`);
  for (const r of rows) console.error(`  ${r.id}`);
  console.error("\nsettle them (npm run settle-live) or re-run with --force");
  await closePool();
  process.exit(1);
}

const started = Date.now();
await getPool().query(
  `TRUNCATE attribution_runs, incident_members, incidents, segment_windows, segment_baselines,
            promises_to_pay, checkout_sessions, settlements, action_attempts, token_burns,
            capability_tokens, policy_decisions, contact_budgets, claims, agent_runs,
            scheduled_actions, obligation_locks, case_revisions, case_events, evidence, ledger,
            cases, obligations, customers, merchants RESTART IDENTITY CASCADE`,
);
console.log(`reset in ${Date.now() - started}ms${force && rows.length ? ` (forced past ${rows.length} live case(s))` : ""}`);
await closePool();
