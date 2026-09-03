import { defineConfig } from "vitest/config";

const TEST_DB = process.env["TEST_DATABASE_NAME"] ?? "recovery_agent_test";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["tests/global-setup.ts", "**/node_modules/**", "**/dist/**"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    // Tests own their database and TRUNCATE between cases. Pointing them at a
    // separate one means `npm run check` can never wipe a demo run mid-session.
    env: { DATABASE_URL: `postgres://localhost:5432/${TEST_DB}` },
    // Suites share that one database, so files must not run concurrently.
    fileParallelism: false,
  },
});
