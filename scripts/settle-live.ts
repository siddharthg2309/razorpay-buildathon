/**
 * Pull-mode settlement for live cases.
 *
 * The webhook is the push path; this is the same reconciliation done by asking.
 * It exists because a demo machine behind NAT has no public URL, and because a
 * missed delivery must not mean a recovered case stays open forever.
 */
import { RealClock, loadConfig } from "@rra/core";
import { Ledger, closePool, getPool } from "@rra/db";
import { RazorpayTestAdapter } from "@rra/connectors";
import { Reconciler, Verifier } from "@rra/engine";

const keyId = process.env["RAZORPAY_KEY_ID"];
const keySecret = process.env["RAZORPAY_KEY_SECRET"];
if (!keyId || !keySecret) {
  console.error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
  process.exit(1);
}

const clock = new RealClock();
const adapter = new RazorpayTestAdapter({
  keyId, keySecret, webhookSecret: process.env["RAZORPAY_WEBHOOK_SECRET"] ?? "",
});
const verifier = new Verifier(new Reconciler(clock), new Ledger(clock), clock);
void loadConfig();

const { rows } = await getPool().query<{
  case_id: string; idem_key: string; amount_paise: string; merchant_id: string;
}>(
  `SELECT a.case_id, a.idem_key, o.amount_paise, o.merchant_id
     FROM action_attempts a
     JOIN cases c ON c.id = a.case_id
     JOIN obligations o ON o.id = a.obligation_id
    WHERE a.surface = 'live' AND c.closed_at IS NULL
    ORDER BY a.sent_at`,
);

if (rows.length === 0) {
  console.log("no open live cases");
  await closePool();
  process.exit(0);
}

console.log(`checking ${rows.length} open live case(s)\n`);
for (const r of rows) {
  const status = await adapter.fetchPaymentStatus(r.idem_key);
  const label = `${r.case_id}  ${r.idem_key.slice(0, 12)}…`;
  if (!status.captured) {
    console.log(`  ${label}  found=${status.found} captured=false — still open`);
    continue;
  }
  const out = await verifier.onSettlement({
    id: `set_live_${r.idem_key.slice(0, 24)}`,
    merchantId: r.merchant_id,
    amountPaise: status.amountPaise ?? Number(r.amount_paise),
    source: "razorpay_test",
    idemKey: r.idem_key,
  });
  console.log(`  ${label}  captured ${(status.amountPaise ?? 0) / 100} → ${out.kind}`);
  if (out.kind === "recovered") {
    console.log(`         read the trail: http://localhost:4000/case/${r.case_id}`);
  }
}
await closePool();
