/**
 * Tests run against their own database.
 *
 * They TRUNCATE between cases, so sharing a database with the demo means a
 * routine `npm run check` silently destroys a live run — which is exactly how a
 * real Razorpay capture was lost after it had already been paid. Separating
 * them makes that impossible rather than merely unlikely.
 */
import { execSync } from "node:child_process";

const TEST_DB = process.env["TEST_DATABASE_NAME"] ?? "recovery_agent_test";

export default async function setup(): Promise<void> {
  const url = `postgres://localhost:5432/${TEST_DB}`;
  process.env["DATABASE_URL"] = url;

  try {
    execSync(`createdb ${TEST_DB}`, { stdio: "ignore" });
  } catch {
    // Already exists — migrations below are idempotent.
  }
  execSync("node --import tsx packages/db/src/migrate.ts", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: url },
  });
}
