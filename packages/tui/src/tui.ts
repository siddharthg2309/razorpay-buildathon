/**
 * Terminal view. Same event source as the web console, rendered for a shell.
 *
 * No chalk dependency: raw ANSI is a handful of constants, and one fewer
 * package is one fewer thing that can fail to resolve on demo day.
 */
import { closePool } from "@rra/db";
import { readSince, type StreamLine } from "@rra/console/stream";

const ESC = String.fromCharCode(27);
const C = {
  reset: ESC + "[0m", dim: ESC + "[2m", bold: ESC + "[1m",
  grey: ESC + "[90m", amber: ESC + "[33m", green: ESC + "[32m",
  red: ESC + "[31m", blue: ESC + "[34m", white: ESC + "[37m",
} as const;

const COLOUR: Record<string, string> = {
  TIER0: C.white, TIER1: C.amber, CLAIM: C.amber,
  POLICY: C.green, BLOCK: C.red, EXEC: C.white,
  VERIFY: C.green, INCIDENT: C.blue, DETECT: C.grey,
};

const pad = (s: string, n: number): string => s.padEnd(n).slice(0, n);

function render(l: StreamLine): string {
  const colour = COLOUR[l.kind] ?? C.reset;
  return C.grey + pad(l.caseId, 12) + C.reset + colour + pad(l.kind, 10) + C.reset + l.text;
}

let cursor = Number(process.argv[2] ?? 0);
let running = true;

console.log(C.bold + "revenue recovery agent - live" + C.reset + "  " + C.dim + "(ctrl-c to exit)" + C.reset + "\n");

async function loop(): Promise<void> {
  while (running) {
    try {
      for (const line of await readSince(cursor, 200)) {
        cursor = line.id;
        console.log(render(line));
      }
    } catch (err) {
      console.error(C.red + "stream error:" + C.reset + " " + (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

process.on("SIGINT", () => {
  running = false;
  void closePool().then(() => process.exit(0));
});

await loop();
