import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * L0 webhook signature verification.
 *
 * Nothing downstream is allowed to trust an inbound event that has not passed
 * this. Without it a spoofed `payment.failed` is a free way to make the agent
 * open a case and contact an arbitrary customer — the injection posture on
 * customer *text* is worthless if the event itself can be forged.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  // Compare in constant time, and only when lengths match — timingSafeEqual
  // throws on a length mismatch, which would itself leak.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type RazorpayEventType =
  | "payment.failed"
  | "payment.captured"
  | "payment_link.paid"
  | "subscription.charged"
  | "subscription.pending"
  | "subscription.halted"
  | "payment.downtime.started"
  | "payment.downtime.resolved";

export interface NormalizedEvent {
  eventId: string;
  type: RazorpayEventType;
  occurredAt: Date;
  merchantId: string;
  externalRef: string | null;
  amountPaise: number | null;
  rail: string | null;
  errorCode: string | null;
  /** Merchant notes we set when creating the entity — our own identifiers. */
  notes: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export class UnverifiedWebhookError extends Error {
  constructor() {
    super("webhook signature did not verify; refusing to process");
    this.name = "UnverifiedWebhookError";
  }
}

const METHOD_TO_RAIL: Record<string, string> = {
  card: "card",
  upi: "upi_collect",
  netbanking: "netbanking",
  wallet: "wallet",
  emandate: "enach",
  nach: "enach",
};

/**
 * Verify, then normalise. The order is the point: parsing an unverified body
 * is already trusting it.
 */
export function ingestWebhook(
  rawBody: string,
  signature: string,
  secret: string,
  merchantId: string,
): NormalizedEvent {
  if (!verifyWebhookSignature(rawBody, signature, secret)) throw new UnverifiedWebhookError();

  const body = JSON.parse(rawBody) as {
    event: RazorpayEventType;
    created_at?: number;
    payload?: Record<string, { entity?: Record<string, unknown> }>;
  };
  const entity =
    body.payload?.["payment"]?.entity ??
    body.payload?.["payment_link"]?.entity ??
    body.payload?.["subscription"]?.entity ??
    {};

  const method = typeof entity["method"] === "string" ? entity["method"] : null;
  const notes = (entity["notes"] ?? {}) as Record<string, unknown>;

  return {
    // Razorpay ids are stable per entity, which is what makes dedup possible.
    eventId: String(entity["id"] ?? `${body.event}:${body.created_at ?? 0}`),
    type: body.event,
    occurredAt: new Date((body.created_at ?? 0) * 1000),
    merchantId,
    externalRef:
      (typeof notes["external_ref"] === "string" ? notes["external_ref"] : null) ??
      (typeof entity["reference_id"] === "string" ? entity["reference_id"] : null),
    amountPaise: typeof entity["amount"] === "number" ? entity["amount"] : null,
    rail: method ? (METHOD_TO_RAIL[method] ?? method) : null,
    notes,
    errorCode:
      (typeof entity["error_reason"] === "string" ? entity["error_reason"] : null) ??
      (typeof entity["error_code"] === "string" ? entity["error_code"] : null),
    raw: entity,
  };
}
