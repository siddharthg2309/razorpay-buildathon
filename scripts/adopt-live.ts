/**
 * Adopt a paid Razorpay link whose case record no longer exists.
 *
 * This is reconciliation, not reconstruction: the provider holds the truth that
 * money arrived, and the engine's job is to match it to an obligation. It
 * exists because case data can be lost — a mistaken reset, a restored backup —
 * while the money at the provider is unaffected, and leaving real money
 * unmatched is worse than re-establishing the record it belongs to.
 *
 * Every row it writes is labelled `adopted` so the trail never implies the
 * agent drove the recovery it is recording.
 */
import { randomUUID } from "node:crypto";
import { RealClock } from "@rra/core";
import { Ledger, closePool, getPool, CaseEventStore } from "@rra/db";
import { Reconciler, Verifier } from "@rra/engine";

const linkId = process.argv[2];
const keyId = process.env["RAZORPAY_KEY_ID"];
const keySecret = process.env["RAZORPAY_KEY_SECRET"];
if (!linkId?.startsWith("plink_") || !keyId || !keySecret) {
  console.error("usage: npm run adopt-live -- plink_XXXXXXXX");
  process.exit(1);
}

const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
const res = await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}`, {
  headers: { Authorization: `Basic ${auth}` },
});
if (!res.ok) {
  console.error(`razorpay returned ${res.status} for ${linkId}`);
  process.exit(1);
}
const link = (await res.json()) as {
  id: string; status: string; amount: number; amount_paid: number; reference_id: string;
};

console.log(`link ${link.id}  status=${link.status}  paid=${link.amount_paid / 100}`);
if (link.status !== "paid") {
  console.error("not paid — nothing to adopt");
  await closePool();
  process.exit(1);
}

const merchant = process.env["RAZORPAY_MERCHANT_ID"] ?? "acme-subscriptions";
const suffix = link.reference_id.slice(0, 8);
const caseId = `live_adopted_${suffix}`;
const obligationId = `ob_adopted_${suffix}`;
const clock = new RealClock();
const events = new CaseEventStore(clock);
const ledger = new Ledger(clock);
const verifier = new Verifier(new Reconciler(clock), ledger, clock);

await getPool().query(
  "INSERT INTO merchants (id,name,policy_version) VALUES ($1,$1,'v7') ON CONFLICT (id) DO NOTHING",
  [merchant],
);
await getPool().query(
  "INSERT INTO customers (id,merchant_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING",
  [`cu_adopted_${suffix}`, merchant],
);
await getPool().query(
  `INSERT INTO obligations (id, merchant_id, customer_id, type, amount_paise, due_at, external_ref, state)
   VALUES ($1,$2,$3,'payment_failure',$4,$5,$6,'due') ON CONFLICT (id) DO NOTHING`,
  [obligationId, merchant, `cu_adopted_${suffix}`, link.amount, clock.now(), link.reference_id],
);
await getPool().query(
  `INSERT INTO cases (id, obligation_id, domain, state, holdout_flag, opened_at, cause, rail)
   VALUES ($1,$2,'payment_failure','DETECTED',false,$3,'adopted_from_provider','card')
   ON CONFLICT (id) DO NOTHING`,
  [caseId, obligationId, clock.now()],
);
await events.append(caseId, { type: "case_opened", domain: "payment_failure", holdout: false }, "adopt");

await getPool().query(
  `INSERT INTO action_attempts
     (id, case_id, obligation_id, action_id, attempt_no, idem_key, surface, state, request, response, sent_at, settled_at)
   VALUES ($1,$2,$3,'create_payment_link',0,$4,'live','reconciled',$5,$6,$7,$7)
   ON CONFLICT (idem_key) DO NOTHING`,
  [
    randomUUID(), caseId, obligationId, `adopted:${link.reference_id}`,
    JSON.stringify({ adopted: true, linkId: link.id }),
    JSON.stringify({ ...link, adopted: true }), clock.now(),
  ],
);
await ledger.append({
  caseId, actor: "adopt", eventType: "adopted_from_provider",
  payload: { linkId: link.id, referenceId: link.reference_id, note: "case record re-established from provider truth; the agent did not drive this recovery" },
});

const outcome = await verifier.onSettlement({
  id: `set_adopted_${link.id}`,
  merchantId: merchant,
  amountPaise: link.amount_paid,
  source: "razorpay_test",
  reference: link.reference_id,
});

const { rows } = await getPool().query<{ state: string; terminal_reason: string }>(
  "SELECT state, terminal_reason FROM cases WHERE id = $1", [caseId],
);
console.log(`\ncase ${caseId} → ${rows[0]?.state} (${rows[0]?.terminal_reason}) via ${outcome.kind}`);
console.log(`read the trail: http://localhost:4000/case/${caseId}`);
await closePool();
