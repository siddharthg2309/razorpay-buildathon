/** Returns the database to a known empty state. Must be fast — on stage this
 *  runs between takes, and a slow reset is a dead pause in a five-minute slot. */
import { closePool, getPool } from "@rra/db";

const started = Date.now();
await getPool().query(
  `TRUNCATE attribution_runs, incident_members, incidents, segment_windows, segment_baselines,
            settlements, action_attempts, token_burns, capability_tokens, policy_decisions,
            contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks,
            case_revisions, case_events, evidence, ledger, cases, obligations, customers,
            merchants RESTART IDENTITY CASCADE`,
);
console.log(`reset in ${Date.now() - started}ms`);
await closePool();
