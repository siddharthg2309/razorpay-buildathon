import type { Clock, CapabilityToken } from "@rra/core";
import { getPool } from "@rra/db";

export class TokenReplayError extends Error {
  constructor(nonce: string) {
    super(`capability token ${nonce.slice(0, 8)}… has already been burned`);
    this.name = "TokenReplayError";
  }
}

/**
 * Step 4 of connector admission.
 *
 * Single-use is enforced by a unique index, not by a flag someone remembers to
 * check: a duplicate insert *is* the replay detection. This also gives
 * idempotency from the same mechanism — the same token cannot drive two calls.
 */
export class TokenBurner {
  constructor(private readonly clock: Clock) {}

  async burn(token: CapabilityToken): Promise<void> {
    try {
      await getPool().query(
        "INSERT INTO token_burns (nonce, case_id, action_id, burned_at) VALUES ($1,$2,$3,$4)",
        [token.nonce, token.caseId, token.actionId, this.clock.now()],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new TokenReplayError(token.nonce);
      throw err;
    }
  }

  async isBurned(nonce: string): Promise<boolean> {
    const { rowCount } = await getPool().query("SELECT 1 FROM token_burns WHERE nonce = $1", [nonce]);
    return (rowCount ?? 0) > 0;
  }
}
