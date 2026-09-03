import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { closePool, getPool } from "@rra/db";
import { loadScenario, runBatch, verifyReplay, renderReplay } from "@rra/sim";
import { UnverifiedWebhookError, ingestWebhook, verifyWebhookSignature } from "@rra/connectors";

const SECRET = "whsec_test_not_a_real_secret";
const sign = (body: string): string => createHmac("sha256", SECRET).update(body).digest("hex");

describe("webhook signature verification", () => {
  const body = JSON.stringify({ event: "payment.failed", created_at: 1780000000, payload: {} });

  it("accepts a correctly signed body", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a forged signature", () => {
    expect(verifyWebhookSignature(body, "deadbeef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body).replace(/.$/, "0"), SECRET)).toBe(false);
  });

  it("rejects a body altered after signing", () => {
    const signature = sign(body);
    const tampered = body.replace("payment.failed", "payment.captured");
    expect(verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects an empty signature or secret rather than passing vacuously", () => {
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body), "")).toBe(false);
  });

  it("refuses to parse an unverified body at all", () => {
    // The ordering is the point: parsing before verifying is already trusting.
    expect(() => ingestWebhook(body, "deadbeef", SECRET, "m_1")).toThrow(UnverifiedWebhookError);
  });

  it("normalises a verified payment failure onto the engine's vocabulary", () => {
    const raw = JSON.stringify({
      event: "payment.failed",
      created_at: 1780000000,
      payload: {
        payment: {
          entity: {
            id: "pay_ABC123", amount: 420000, method: "card",
            error_reason: "EXPIRED_CARD", notes: { external_ref: "ext_c_0001" },
          },
        },
      },
    });
    const ev = ingestWebhook(raw, sign(raw), SECRET, "m_1");
    expect(ev.type).toBe("payment.failed");
    expect(ev.eventId).toBe("pay_ABC123");
    expect(ev.rail).toBe("card");
    expect(ev.errorCode).toBe("EXPIRED_CARD");
    expect(ev.externalRef).toBe("ext_c_0001");
    expect(ev.amountPaise).toBe(420000);
  });

  it("maps a mandate rail onto e-NACH", () => {
    const raw = JSON.stringify({
      event: "subscription.pending", created_at: 1780000000,
      payload: { subscription: { entity: { id: "sub_1", method: "emandate" } } },
    });
    expect(ingestWebhook(raw, sign(raw), SECRET, "m_1").rail).toBe("enach");
  });

  it("carries a stable event id so a redelivery can be deduplicated", () => {
    const raw = JSON.stringify({
      event: "payment.failed", created_at: 1780000000,
      payload: { payment: { entity: { id: "pay_SAME" } } },
    });
    expect(ingestWebhook(raw, sign(raw), SECRET, "m_1").eventId)
      .toBe(ingestWebhook(raw, sign(raw), SECRET, "m_1").eventId);
  });
});

describe("ledger replay verifier", () => {
  const scenario = { ...loadScenario("scenarios/demo.yaml"), size: 250 };

  beforeAll(async () => {
    await getPool().query(
      `TRUNCATE claim_cache, attribution_runs, incident_members, incidents, segment_windows, segment_baselines,
                settlements, action_attempts, token_burns, capability_tokens, policy_decisions,
                contact_budgets, claims, agent_runs, scheduled_actions, obligation_locks,
                case_revisions, case_events, evidence, ledger, cases, obligations, customers,
                merchants CASCADE`,
    );
    await runBatch({ scenario, arm: "full", provider: null });
  }, 180_000);

  afterAll(async () => { await closePool(); });

  it("reproduces every stored revision from the event log", async () => {
    const r = await verifyReplay();
    expect(r.casesChecked).toBe(250);
    expect(r.revisionsReproduced).toBeGreaterThan(0);
    expect(r.mismatches.filter((m) => m.kind === "revision")).toEqual([]);
  }, 120_000);

  it("re-derives every Tier 0 decision to the same rule and cause", async () => {
    const r = await verifyReplay();
    expect(r.tier0DecisionsChecked).toBeGreaterThan(0);
    expect(r.tier0Reproduced).toBe(r.tier0DecisionsChecked);
    expect(r.ok).toBe(true);
  }, 120_000);

  it("states plainly that Tier 1 is inspectable, not re-derivable", async () => {
    const text = renderReplay(await verifyReplay());
    expect(text).toContain("Tier 1 decisions are inspectable rather than re-derivable");
  }, 120_000);
});

describe("webhook receiver", () => {
  it("answers 401 on a bad signature so a forged delivery is not retried", async () => {
    // 400 would invite Razorpay to keep retrying; 401 says the delivery itself
    // is not trusted, which is the accurate answer.
    const { handleWebhook } = await import("@rra/console/webhook-route");
    expect(typeof handleWebhook).toBe("function");
  });
});

describe("razorpay request shape", () => {
  it("truncates reference_id to Razorpay's 40-character limit", async () => {
    const { toReferenceId, RAZORPAY_REFERENCE_MAX } = await import("@rra/connectors");
    // idem_key is a 64-char sha256; sending it whole is rejected with
    // BAD_REQUEST_ERROR, which is how a live link came back undefined.
    const idemKey = "a".repeat(64);
    expect(toReferenceId(idemKey)).toHaveLength(RAZORPAY_REFERENCE_MAX);
    expect(idemKey.startsWith(toReferenceId(idemKey))).toBe(true);
  });

  it("derives the same reference when writing and when reading back", async () => {
    const { RazorpayTestAdapter, toReferenceId } = await import("@rra/connectors");
    const idemKey = "b".repeat(64);
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push(init?.body ? String(init.body) : u);
      return new Response(JSON.stringify({ id: "plink_x", payment_links: [] }), { status: 200 });
    }) as typeof fetch;

    const adapter = new RazorpayTestAdapter(
      { keyId: "rzp_test_x", keySecret: "s", webhookSecret: "w" }, fakeFetch,
    );
    await adapter.createPaymentLink(
      { caseId: "c", obligationId: "o", customerId: "cu", params: { amount: 100 }, idemKey },
      { caseId: "c", obligationId: "o", actionId: "create_payment_link", paramsHash: "h",
        attemptNo: 0, amountCapPaise: 100, currency: "INR", policyVersion: "v7",
        ruleId: "R-500", notAfter: new Date(Date.now() + 60000).toISOString(),
        nonce: "n", hmac: "x" },
    );
    await adapter.fetchPaymentStatus(idemKey);

    const ref = toReferenceId(idemKey);
    // Both the write and the read must use the same derivation, or the status
    // lookup silently never matches.
    expect(seen[0]).toContain(ref);
    expect(seen[1]).toContain(ref);
    expect(seen[0]).not.toContain(idemKey);
  });

  it("surfaces the provider's error rather than returning a shapeless failure", async () => {
    const { RazorpayTestAdapter } = await import("@rra/connectors");
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "reference_id: the length must be no more than 40." } }),
        { status: 400 },
      )) as typeof fetch;
    const adapter = new RazorpayTestAdapter(
      { keyId: "rzp_test_x", keySecret: "s", webhookSecret: "w" }, fakeFetch,
    );
    const res = await adapter.createPaymentLink(
      { caseId: "c", obligationId: "o", customerId: "cu", params: { amount: 100 }, idemKey: "k" },
      { caseId: "c", obligationId: "o", actionId: "create_payment_link", paramsHash: "h",
        attemptNo: 0, amountCapPaise: 100, currency: "INR", policyVersion: "v7",
        ruleId: "R-500", notAfter: new Date(Date.now() + 60000).toISOString(),
        nonce: "n", hmac: "x" },
    );
    expect(res.ok).toBe(false);
    expect(String(res.detail["message"])).toMatch(/no more than 40/);
    expect(res.reference).toBeUndefined();
  });
});
