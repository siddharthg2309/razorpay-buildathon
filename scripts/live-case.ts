/**
 * The one live case.
 *
 * Creates a real Razorpay Test Mode payment link for a real case in the
 * database, then polls fetchPaymentStatus until the money arrives. Run it,
 * open the link, pay with a test card, and watch the case close.
 *
 * This is the beat that converts "simulated" from a category into a scope: the
 * payment world is simulated, the connector is not.
 */
import { randomUUID } from "node:crypto";
import { CapabilityMinter, RealClock, hashParams, loadConfig, loadPolicy } from "@rra/core";
import { CaseEventStore, Ledger, closePool, getPool } from "@rra/db";
import { RazorpayTestAdapter } from "@rra/connectors";
import {
  CaseManager, Executor, ObligationLease, PolicyEngine, Reconciler, TokenBurner, Verifier,
} from "@rra/engine";

const keyId = process.env["RAZORPAY_KEY_ID"];
const keySecret = process.env["RAZORPAY_KEY_SECRET"];
if (!keyId?.startsWith("rzp_test_") || !keySecret) {
  console.error("RAZORPAY_KEY_ID must be a rzp_test_ key and RAZORPAY_KEY_SECRET must be set");
  process.exit(1);
}

const merchant = process.env["RAZORPAY_MERCHANT_ID"] ?? "acme-subscriptions";
const amountPaise = Number(process.argv[2] ?? 50_000);

const clock = new RealClock();
const config = loadConfig();
const policy = loadPolicy(`${process.cwd()}/policies/acme-subscriptions.yaml`);
const adapter = new RazorpayTestAdapter({
  keyId, keySecret, webhookSecret: process.env["RAZORPAY_WEBHOOK_SECRET"] ?? "",
});
const minter = new CapabilityMinter(
  Buffer.from(process.env["CAPABILITY_SIGNING_KEY"] ?? "live-case"), clock, 30 * 60_000,
);
const reconciler = new Reconciler(clock);
const verifier = new Verifier(reconciler, new Ledger(clock), clock);
const executor = new Executor(adapter, config.library, minter, new TokenBurner(clock), new ObligationLease(clock), clock);
const policyEngine = new PolicyEngine(policy, config.library, minter, clock);
const cases = new CaseManager(clock);
const events = new CaseEventStore(clock);

const suffix = randomUUID().slice(0, 8);
const caseId = `live_${suffix}`;
const customerId = `cu_live_${suffix}`;

await getPool().query(
  "INSERT INTO merchants (id, name, policy_version) VALUES ($1,$1,'v7') ON CONFLICT (id) DO NOTHING",
  [merchant],
);
await getPool().query(
  "INSERT INTO customers (id, merchant_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING",
  [customerId, merchant],
);

await cases.openOrAttach({
  caseId, merchantId: merchant, customerId,
  obligationId: `ob_${suffix}`, externalRef: `live_${suffix}`,
  domain: "payment_failure", amountPaise, dueAt: clock.now(), holdout: false,
});
console.log(`case ${caseId} opened — ${amountPaise / 100} rupees at risk\n`);

const params = { amount: amountPaise, currency: "INR", expiry_hours: 24 };
const auth = await policyEngine.authorize({
  caseId, obligationId: `ob_${suffix}`, customerId,
  rail: "card", actionId: "create_payment_link", params, attemptNo: 0, amountPaise,
});
console.log(`policy ${auth.decision.outcome.toUpperCase()} · rule ${auth.decision.ruleId} · ${auth.decision.reason}`);
if (!auth.token) {
  console.error("policy did not authorise the action");
  await closePool();
  process.exit(1);
}
console.log(`token tk_${auth.token.nonce.slice(0, 6)} · cap ${(auth.token.amountCapPaise ?? 0) / 100} · policy ${auth.token.policyVersion}\n`);

await events.append(caseId, { type: "diagnosis_started", tier: 0 }, "live_case");
await events.append(caseId, { type: "plan_proposed", planVersion: 1 }, "live_case");
await events.append(caseId, { type: "action_scheduled", actionId: "create_payment_link", fireAt: clock.now().toISOString() }, "live_case");
await events.append(caseId, { type: "approval_granted", approver: "policy_engine" }, "live_case");

const out = await executor.execute({
  caseId, obligationId: `ob_${suffix}`, customerId,
  actionId: "create_payment_link", attemptNo: 0, params, token: auth.token, amountPaise,
});

// Fail loudly. An unchecked result printed a link id of `undefined` and then
// polled for five minutes against a link that was never created.
if (!out.result.ok) {
  console.error(`\nrazorpay refused the call: ${out.result.detail["message"] ?? JSON.stringify(out.result.detail)}`);
  await closePool();
  process.exit(1);
}

await events.append(caseId, { type: "action_executed", actionId: "create_payment_link", attemptNo: 0 }, "executor");

const link = (out.result.detail as { short_url?: string })["short_url"];
console.log(`LIVE payment link ${out.result.reference}`);
console.log(`  ${link ?? "(no short_url returned)"}`);
console.log(`  idem ${out.idemKey.slice(0, 16)}…  surface ${out.surface}\n`);
console.log("open it, pay with a Razorpay test card, and this will close the case.\n");

// Poll rather than wait on the webhook, so the beat works without a tunnel.
// The webhook path is the same reconciliation, just push instead of pull.
const deadline = Date.now() + 5 * 60_000;
let closedBy: string | null = null;
while (Date.now() < deadline && !closedBy) {
  const status = await adapter.fetchPaymentStatus(out.idemKey);
  // Only rewrite the line on a terminal; piped output would otherwise be one
  // enormous line of repeated polls.
  const line = `  polling… found=${status.found} captured=${status.captured}`;
  if (process.stdout.isTTY) process.stdout.write(`${line}\r`);
  else console.log(line);
  if (status.captured) {
    const settled = await verifier.onSettlement({
      id: `set_live_${suffix}`, merchantId: merchant,
      amountPaise: status.amountPaise ?? amountPaise, source: "razorpay_test", idemKey: out.idemKey,
    });
    closedBy = settled.kind;
    break;
  }
  await new Promise((r) => setTimeout(r, 4000));
}

console.log("");
if (closedBy === "recovered") {
  const { rows } = await getPool().query<{ state: string; terminal_reason: string }>(
    "SELECT state, terminal_reason FROM cases WHERE id = $1", [caseId],
  );
  console.log(`case ${caseId} → ${rows[0]?.state} (${rows[0]?.terminal_reason})`);
  console.log(`open http://localhost:4000/case/${caseId} to read the trail`);
} else {
  console.log(`no capture within the window. the link is still open:`);
  console.log(`  ${link ?? out.result.reference}`);
  console.log(`re-run with the same link, or let the webhook close it once you pay.`);
}
await closePool();
