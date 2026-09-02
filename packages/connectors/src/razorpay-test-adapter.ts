import type { CapabilityToken } from "@rra/core";
import {
  UnsupportedCapabilityError,
  type AdapterCall,
  type CallResult,
  type CapabilityName,
  type PaymentStatus,
  type PSPAdapter,
} from "./adapter.js";

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

/**
 * The narrow live proof path.
 *
 * Only the capabilities Razorpay Test Mode genuinely supports are declared.
 * Everything else throws UnsupportedCapabilityError *before* execution rather
 * than failing inside a call, which is the difference between "the connector is
 * real" and "the connector pretends".
 */
export class RazorpayTestAdapter implements PSPAdapter {
  readonly name = "RazorpayTestAdapter";
  readonly surface = "live" as const;

  constructor(
    private readonly creds: RazorpayCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  capabilities(): ReadonlySet<CapabilityName> {
    return new Set<CapabilityName>(["createPaymentLink", "fetchPaymentStatus"]);
  }

  async createPaymentLink(call: AdapterCall, token: CapabilityToken): Promise<CallResult> {
    const auth = Buffer.from(`${this.creds.keyId}:${this.creds.keySecret}`).toString("base64");
    const res = await this.fetchImpl("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        // The connector's own idempotency, independent of the burned nonce.
        "X-Idempotency-Key": call.idemKey,
      },
      body: JSON.stringify({
        amount: token.amountCapPaise ?? call.params["amount"],
        currency: "INR",
        reference_id: call.idemKey,
        expire_by: Math.floor(new Date(token.notAfter).getTime() / 1000) + 86_400,
        notes: { case_id: call.caseId, obligation_id: call.obligationId },
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: res.ok,
      ...(typeof body["id"] === "string" ? { reference: body["id"] } : {}),
      detail: body,
    };
  }

  async fetchPaymentStatus(idemKey: string): Promise<PaymentStatus> {
    const auth = Buffer.from(`${this.creds.keyId}:${this.creds.keySecret}`).toString("base64");
    const res = await this.fetchImpl(
      `https://api.razorpay.com/v1/payment_links?reference_id=${encodeURIComponent(idemKey)}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!res.ok) return { found: false, captured: false };
    const body = (await res.json()) as { payment_links?: { id: string; status: string; amount: number }[] };
    const link = body.payment_links?.[0];
    if (!link) return { found: false, captured: false };
    return {
      found: true,
      captured: link.status === "paid",
      amountPaise: link.amount,
      reference: link.id,
    };
  }

  resumeCheckout(): Promise<CallResult> {
    throw new UnsupportedCapabilityError(this.name, "resumeCheckout");
  }
  requestPaymentMethodUpdate(): Promise<CallResult> {
    throw new UnsupportedCapabilityError(this.name, "requestPaymentMethodUpdate");
  }
  sendApprovedTemplate(): Promise<CallResult> {
    throw new UnsupportedCapabilityError(this.name, "sendApprovedTemplate");
  }
  createOpsEscalation(): Promise<CallResult> {
    throw new UnsupportedCapabilityError(this.name, "createOpsEscalation");
  }
}
