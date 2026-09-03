import { createHash } from "node:crypto";

/**
 * Per-draw randomness that does not depend on evaluation order.
 *
 * A shared sequential generator is deterministic only while the calls happen in
 * the same order every time — which stops being true the moment cases are
 * planned concurrently. Hashing the identity of the draw instead means two runs
 * agree whatever order they execute in, and the batch stays reproducible while
 * getting faster.
 */
export function draw(seed: number, ...parts: (string | number)[]): number {
  const digest = createHash("sha256").update(`${seed}|${parts.join("|")}`).digest();
  // Six bytes is ample resolution and stays inside a safe integer.
  return digest.readUIntBE(0, 6) / 0xffffffffffff;
}
