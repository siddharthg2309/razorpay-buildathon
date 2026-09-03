import type { IncomingMessage, ServerResponse } from "node:http";
import { RealClock } from "@rra/core";
import { Ledger, getPool } from "@rra/db";
import { UnverifiedWebhookError, ingestWebhook } from "@rra/connectors";

const MAX_BODY_BYTES = 1_000_000;

/** Reads the raw body. The signature is over exact bytes, so it cannot be
 *  re-serialised from a parsed object first. */
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("webhook body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The inbound half of the Razorpay boundary.
 *
 * Verify, then dedup, then act. A verified event is still replayed by Razorpay
 * on retry, so the entity id is the dedup key — processing a redelivery twice
 * would double-count a settlement.
 */
export async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = process.env["RAZORPAY_WEBHOOK_SECRET"] ?? "";
  const merchantId = process.env["RAZORPAY_MERCHANT_ID"] ?? "acme-subscriptions";
  const signature = String(req.headers["x-razorpay-signature"] ?? "");
  const ledger = new Ledger(new RealClock());

  let raw: string;
  try {
    raw = await readRawBody(req);
  } catch {
    res.writeHead(413).end("body too large");
    return;
  }

  if (!secret) {
    // Refuse rather than accept unverified traffic. An unconfigured secret is
    // the same security posture as no verification at all.
    res.writeHead(503).end("RAZORPAY_WEBHOOK_SECRET is not configured");
    return;
  }

  let event;
  try {
    event = ingestWebhook(raw, signature, secret, merchantId);
  } catch (err) {
    if (err instanceof UnverifiedWebhookError) {
      // 401, not 400: this is an authentication failure, and answering 400
      // would invite Razorpay to keep retrying a forged delivery.
      res.writeHead(401).end("signature verification failed");
      return;
    }
    res.writeHead(400).end("malformed body");
    return;
  }

  // Razorpay retries on any non-2xx, so a redelivery must be a no-op.
  const { rowCount } = await getPool().query(
    "SELECT 1 FROM ledger WHERE event_type = 'webhook_received' AND payload->>'eventId' = $1 LIMIT 1",
    [event.eventId],
  );
  if ((rowCount ?? 0) > 0) {
    res.writeHead(200).end("duplicate, already processed");
    return;
  }

  await ledger.append({
    caseId: event.externalRef ?? event.eventId,
    actor: "razorpay_webhook",
    eventType: "webhook_received",
    payload: {
      eventId: event.eventId,
      type: event.type,
      rail: event.rail,
      errorCode: event.errorCode,
      externalRef: event.externalRef,
      amountPaise: event.amountPaise,
      surface: "live",
    },
  });

  // Acknowledge fast. Razorpay times out deliveries, and holding the connection
  // open while the engine works turns a slow case into a retried delivery.
  res.writeHead(200).end("ok");
}
