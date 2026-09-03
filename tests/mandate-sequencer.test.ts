import { describe, expect, it } from "vitest";
import { VirtualClock, hours, loadConfig } from "@rra/core";
import { MandateRetrySequencer, PRE_DEBIT_NOTICE_MS, type MandateFacts } from "@rra/engine";

const T0 = new Date("2026-09-02T09:00:00Z");
const config = loadConfig();
const seq = (at = T0) => new MandateRetrySequencer(new VirtualClock(at), config.taxonomy);

const facts = (over: Partial<MandateFacts> = {}): MandateFacts => ({
  rail: "upi_autopay",
  state: "active",
  capPaise: null,
  amountPaise: 420_000,
  preDebitNotifiedAt: null,
  attemptNo: 0,
  nextPresentationAt: null,
  ...over,
});

describe("mandate retry sequencer", () => {
  it("orders the pre-debit notification before the debit, never the reverse", () => {
    const out = seq().sequence(facts());
    expect(out.permitted).toBe(true);
    const ids = out.steps.map((s) => s.actionId);
    // The whole point. A sequencer that debits first and notifies after is
    // compliant on paper and wrong in practice.
    expect(ids.indexOf("await_mandate_prerequisite")).toBeLessThan(
      ids.indexOf("await_provider_retry"),
    );
  });

  it("holds the debit for the full notice period", () => {
    const out = seq().sequence(facts());
    const debit = out.steps.find((s) => s.actionId === "await_provider_retry")!;
    expect(debit.delayMs).toBe(PRE_DEBIT_NOTICE_MS);
  });

  it("waits only the remainder when notice has already partly run", () => {
    const out = seq(new Date(T0.getTime() + hours(20))).sequence(
      facts({ preDebitNotifiedAt: T0 }),
    );
    const debit = out.steps.find((s) => s.actionId === "await_provider_retry")!;
    expect(debit.delayMs).toBe(hours(4));
    expect(debit.because).toMatch(/4h still to run/);
  });

  it("refuses any debit on a revoked mandate and asks for a new one", () => {
    const out = seq().sequence(facts({ state: "revoked" }));
    expect(out.permitted).toBe(false);
    expect(out.blockedBy).toMatch(/revoked/);
    // No delay makes a revoked mandate succeed, so every retry is pure harm.
    expect(out.steps.map((s) => s.actionId)).toEqual(["request_payment_method_update"]);
    expect(out.steps.some((s) => s.actionId.includes("retry"))).toBe(false);
  });

  it("refuses on a paused mandate, because only the payer can lift it", () => {
    const out = seq().sequence(facts({ state: "paused" }));
    expect(out.permitted).toBe(false);
    expect(out.steps[0]?.params["reason_code"]).toBe("MANDATE_PAUSED");
  });

  it("treats a cap breach as a cap problem, not a balance problem", () => {
    const out = seq().sequence(facts({ capPaise: 300_000, amountPaise: 420_000 }));
    expect(out.permitted).toBe(false);
    expect(out.blockedBy).toMatch(/exceeds mandate cap/);
    expect(out.steps[0]?.params["reason_code"]).toBe("MANDATE_AMOUNT_EXCEEDED");
  });

  it("lets the bank presentation cycle set the date on e-NACH", () => {
    const presentation = new Date(T0.getTime() + hours(72));
    const out = seq().sequence(
      facts({ rail: "enach", preDebitNotifiedAt: new Date(T0.getTime() - hours(30)), nextPresentationAt: presentation }),
    );
    const debit = out.steps.find((s) => s.actionId === "await_provider_retry")!;
    expect(debit.delayMs).toBe(hours(72));
    expect(debit.because).toMatch(/bank working days/);
  });

  it("backs off further with each attempt rather than using a fixed delay", () => {
    const notified = new Date(T0.getTime() - hours(30));
    const delays = [0, 1, 2].map(
      (n) =>
        seq().sequence(facts({ preDebitNotifiedAt: notified, attemptNo: n }))
          .steps.find((s) => s.actionId === "await_provider_retry")!.delayMs,
    );
    // A transient failure clears in hours; a balance problem clears on payday.
    expect(delays[0]).toBeLessThan(delays[1]!);
    expect(delays[1]).toBeLessThan(delays[2]!);
  });

  it("refuses to sequence a rail that has no mandate", () => {
    const out = seq().sequence(facts({ rail: "card" }));
    expect(out.permitted).toBe(false);
    expect(out.blockedBy).toMatch(/no mandate/);
  });

  it("defers to the taxonomy on whether another attempt is allowed at all", () => {
    const s = seq();
    expect(s.retryPermitted("upi_autopay", "MANDATE_REVOKED", 0)).toBe(false);
    expect(s.retryPermitted("upi_autopay", "INSUFFICIENT_FUNDS", 0)).toBe(true);
    expect(s.retryPermitted("upi_autopay", "INSUFFICIENT_FUNDS", 3)).toBe(false);
  });
});

describe("voice as a constrained channel", () => {
  it("spends contact budget and obeys quiet hours like any other contact", () => {
    const voice = config.library.get("place_approved_voice_call");
    // A voice channel that escapes these is not a feature, it is an incident.
    expect(voice.consumesContactBudget).toBe(true);
    expect(voice.quietHoursEnforced).toBe(true);
  });

  it("costs more than a message, so the optimizer feels it", () => {
    expect(config.library.get("place_approved_voice_call").actionCostPaise)
      .toBeGreaterThan(config.library.get("send_approved_template").actionCostPaise);
  });

  it("carries a script id and a language, never free-form speech", () => {
    const params = config.library.get("place_approved_voice_call").params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["channel", "language", "script_id", "slots"]);
    expect(JSON.stringify(params)).toContain("hinglish");
  });
});
