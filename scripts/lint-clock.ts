/**
 * Fails if wall-clock time leaks into a path the virtual clock should govern.
 * A single now() default in a migration removes that table from the demo's
 * time control, and it is invisible until the batch produces wrong timings.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOTS = ["migrations", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const BANNED = [
  // Bare now() only — `clock.now()` is the whole point and must not trip this.
  { re: /(?<![.\w])now\(\)/gi, what: "SQL now()" },
  { re: /\bCURRENT_TIMESTAMP\b/gi, what: "CURRENT_TIMESTAMP" },
  { re: /\bDate\.now\(\)/g, what: "Date.now()" },
  { re: /new Date\(\s*\)/g, what: "new Date()" },
];
// clock.ts is the one place wall time is legitimately read.
const ALLOW = [/packages\/core\/src\/clock\.ts$/, /scripts\/lint-clock\.ts$/];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if ([".ts", ".sql"].includes(extname(p))) yield p;
  }
}

const violations: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (ALLOW.some((re) => re.test(file))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("--") || line.trimStart().startsWith("//")) return;
      for (const { re, what } of BANNED) {
        re.lastIndex = 0;
        if (re.test(line)) violations.push(`${file}:${i + 1}  ${what} — use the injected Clock`);
      }
    });
  }
}

if (violations.length) {
  console.error(`clock lint failed (${violations.length}):\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("clock lint passed — no wall-clock reads outside Clock");
