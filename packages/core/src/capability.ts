import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "./clock.js";

export interface CapabilityToken {
  caseId: string;
  obligationId: string;
  actionId: string;
  paramsHash: string;
  attemptNo: number;
  amountCapPaise: number | null;
  currency: "INR";
  policyVersion: string;
  ruleId: string;
  notAfter: string;
  nonce: string;
  hmac: string;
}

export type TokenRejection =
  | "bad_signature"
  | "expired"
  | "action_mismatch"
  | "params_mismatch"
  | "amount_exceeds_cap";

export class TokenRejectedError extends Error {
  constructor(readonly rejection: TokenRejection, detail = "") {
    super(`capability token rejected: ${rejection}${detail ? ` (${detail})` : ""}`);
    this.name = "TokenRejectedError";
  }
}

/** Stable field order — the signature is over this exact string. */
function canonical(t: Omit<CapabilityToken, "hmac">): string {
  return [
    t.caseId, t.obligationId, t.actionId, t.paramsHash, String(t.attemptNo),
    t.amountCapPaise === null ? "null" : String(t.amountCapPaise),
    t.currency, t.policyVersion, t.ruleId, t.notAfter, t.nonce,
  ].join("|");
}

/** Params are hashed, not carried, so the token cannot be enlarged in flight. */
export function hashParams(params: Record<string, unknown>): string {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  return createHmac("sha256", "params").update(sorted).digest("hex");
}

/**
 * The minter. Deterministic code, never a prompt — the policy engine is the
 * only caller, and nothing else holds the signing key.
 */
export class CapabilityMinter {
  constructor(
    private readonly key: Buffer,
    private readonly clock: Clock,
    private readonly ttlMs = 120_000,
  ) {}

  mint(input: Omit<CapabilityToken, "hmac" | "nonce" | "notAfter" | "currency">): CapabilityToken {
    const unsigned = {
      ...input,
      currency: "INR" as const,
      nonce: randomBytes(16).toString("hex"),
      notAfter: new Date(this.clock.now().getTime() + this.ttlMs).toISOString(),
    };
    return { ...unsigned, hmac: this.sign(unsigned) };
  }

  private sign(t: Omit<CapabilityToken, "hmac">): string {
    return createHmac("sha256", this.key).update(canonical(t)).digest("hex");
  }

  /**
   * Steps 1-3 of connector admission. Step 4 (burning the nonce) needs the
   * database and lives in the connector; keeping it out of here means this
   * function stays pure and total.
   */
  verify(
    token: CapabilityToken,
    call: { actionId: string; params: Record<string, unknown>; amountPaise?: number },
  ): void {
    const { hmac, ...unsigned } = token;
    const expected = Buffer.from(this.sign(unsigned), "hex");
    const actual = Buffer.from(hmac, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new TokenRejectedError("bad_signature");
    }
    if (this.clock.now() > new Date(token.notAfter)) {
      throw new TokenRejectedError("expired", token.notAfter);
    }
    if (token.actionId !== call.actionId) {
      throw new TokenRejectedError("action_mismatch", `${token.actionId} != ${call.actionId}`);
    }
    if (token.paramsHash !== hashParams(call.params)) {
      throw new TokenRejectedError("params_mismatch");
    }
    if (
      token.amountCapPaise !== null &&
      call.amountPaise !== undefined &&
      call.amountPaise > token.amountCapPaise
    ) {
      throw new TokenRejectedError(
        "amount_exceeds_cap",
        `${call.amountPaise} > ${token.amountCapPaise}`,
      );
    }
  }
}
