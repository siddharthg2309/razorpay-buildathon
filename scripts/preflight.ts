/**
 * Razorpay Test Mode preflight.
 *
 * Run this before the demo, not during it. It proves the credentials work, the
 * connector's live path executes, and the webhook secret verifies — the three
 * things that cannot be recovered from on stage.
 */
import { RealClock } from "@rra/core";
import { RazorpayTestAdapter, verifyWebhookSignature } from "@rra/connectors";
import { CapabilityMinter, hashParams } from "@rra/core";

const keyId = process.env["RAZORPAY_KEY_ID"];
const keySecret = process.env["RAZORPAY_KEY_SECRET"];
const webhookSecret = process.env["RAZORPAY_WEBHOOK_SECRET"];

const check = (label: string, ok: boolean, detail = ""): boolean => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

console.log("razorpay test-mode preflight\n");
let allOk = true;

allOk = check("RAZORPAY_KEY_ID set", Boolean(keyId)) && allOk;
allOk = check("RAZORPAY_KEY_SECRET set", Boolean(keySecret)) && allOk;
allOk = check("RAZORPAY_WEBHOOK_SECRET set", Boolean(webhookSecret)) && allOk;

if (keyId && !keyId.startsWith("rzp_test_")) {
  allOk = check("key is a TEST key", false, `got ${keyId.slice(0, 9)}… — refusing to run against live`) && allOk;
} else if (keyId) {
  allOk = check("key is a TEST key", true) && allOk;
}

if (webhookSecret) {
  // Signature verification is the inbound half of the boundary. A spoofed
  // payment_failed is otherwise a free way to make the agent contact people.
  const body = JSON.stringify({ event: "payment_link.paid", payload: {} });
  const { createHmac } = await import("node:crypto");
  const good = createHmac("sha256", webhookSecret).update(body).digest("hex");
  allOk = check("webhook signature verifies", verifyWebhookSignature(body, good, webhookSecret)) && allOk;
  allOk = check("forged signature rejected", !verifyWebhookSignature(body, "deadbeef", webhookSecret)) && allOk;
}

if (keyId && keySecret && allOk) {
  const adapter = new RazorpayTestAdapter({ keyId, keySecret, webhookSecret: webhookSecret ?? "" });
  allOk = check(
    "adapter declares only supported capabilities",
    [...adapter.capabilities()].sort().join(",") === "createPaymentLink,fetchPaymentStatus",
    [...adapter.capabilities()].join(", "),
  ) && allOk;

  const clock = new RealClock();
  const minter = new CapabilityMinter(Buffer.from(process.env["CAPABILITY_SIGNING_KEY"] ?? "preflight"), clock);
  const params = { amount: 10000, currency: "INR", expiry_hours: 24 };
  const token = minter.mint({
    caseId: "preflight", obligationId: "preflight", actionId: "create_payment_link",
    paramsHash: hashParams(params), attemptNo: 0, amountCapPaise: 10000,
    policyVersion: "preflight", ruleId: "R-500",
  });

  try {
    const res = await adapter.createPaymentLink(
      { caseId: "preflight", obligationId: "preflight", customerId: "preflight",
        params, idemKey: `preflight_${Date.now()}` },
      token,
    );
    allOk = check("live payment link created", res.ok, res.reference ?? JSON.stringify(res.detail).slice(0, 120)) && allOk;
    if (res.ok && res.reference) {
      console.log(`\n  payment link id: ${res.reference}`);
      console.log("  open it in test mode, pay with a test card, and the webhook closes the case.");
    }
  } catch (err) {
    allOk = check("live payment link created", false, (err as Error).message) && allOk;
  }
}

console.log(allOk ? "\npreflight passed" : "\npreflight FAILED — do not rely on the live case");
process.exit(allOk ? 0 : 1);
