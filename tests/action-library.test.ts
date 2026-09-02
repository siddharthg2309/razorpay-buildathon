import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  ForbiddenActionError,
  UnknownActionError,
  loadActionLibrary,
} from "@rra/core";

const lib = loadActionLibrary(join(process.cwd(), "actions/library.yaml"));

describe("action library", () => {
  it("loads and exposes a closed set", () => {
    expect(lib.version).toBe(1);
    expect(lib.all().length).toBeGreaterThan(0);
  });

  it("returns actions sorted, for prompt-prefix cache stability", () => {
    const ids = lib.all().map((a) => a.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("rejects a forbidden action with its documented reason", () => {
    expect(() => lib.get("charge_retry")).toThrow(ForbiddenActionError);
    expect(() => lib.get("charge_retry")).toThrow(/provider owns the retry/);
    expect(() => lib.get("update_routing")).toThrow(ForbiddenActionError);
    expect(() => lib.get("send_message")).toThrow(ForbiddenActionError);
  });

  it("rejects an unknown action", () => {
    expect(() => lib.get("wire_transfer_to_self")).toThrow(UnknownActionError);
  });

  it("binds every capability action to a PSPAdapter method and no schedule action", () => {
    for (const a of lib.all()) {
      if (a.kind === "capability") expect(a.capability).toBeTruthy();
      else expect(a.capability).toBeUndefined();
    }
  });

  it("marks only genuinely supported actions as live", () => {
    const live = lib.all().filter((a) => a.surface === "live").map((a) => a.id);
    expect(live).toEqual(["create_payment_link", "fetch_payment_status"]);
  });

  it("excludes the reconciliation probe from optimizer candidates", () => {
    const ids = lib.selectableForRail("card").map((a) => a.id);
    expect(ids).not.toContain("fetch_payment_status");
    expect(ids).toContain("create_payment_link");
  });

  it("filters candidates by rail", () => {
    const enach = lib.selectableForRail("enach").map((a) => a.id);
    expect(enach).toContain("await_mandate_prerequisite");
    expect(enach).not.toContain("resume_checkout");
  });

  it("resolves p_recover by cause with a default fallback", () => {
    expect(lib.pRecover("create_payment_link", "expired_card")).toBe(0.31);
    expect(lib.pRecover("create_payment_link", "unmapped_code")).toBe(0.22);
  });

  it("flags the actions that consume a contact budget and respect quiet hours", () => {
    const t = lib.get("send_approved_template");
    expect(t.consumesContactBudget).toBe(true);
    expect(t.quietHoursEnforced).toBe(true);
    expect(lib.get("create_payment_link").consumesContactBudget).toBe(false);
  });

  it("caps amount only where money moves", () => {
    expect(lib.get("create_payment_link").amountCapped).toBe(true);
    expect(lib.get("wait").amountCapped).toBe(false);
  });
});
