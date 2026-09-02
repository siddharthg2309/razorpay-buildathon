import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    // Suites share one Postgres and TRUNCATE between cases, so files must not
    // run concurrently — parallel files would wipe each other's fixtures.
    fileParallelism: false,
  },
});
