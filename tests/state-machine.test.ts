import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminal, IllegalTransitionError } from "@rra/core";

describe("case state machine", () => {
  it("allows the happy path", () => {
    const path = ["DETECTED", "DIAGNOSING", "PLANNING", "EXECUTING", "OBSERVING", "SCHEDULED"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("rejects illegal transitions loudly", () => {
    expect(() => assertTransition("DETECTED", "EXECUTING", "test")).toThrow(IllegalTransitionError);
    expect(canTransition("DETECTED", "OBSERVING")).toBe(false);
  });

  it("permits a terminal from any live state", () => {
    for (const s of ["DETECTED", "PLANNING", "EXECUTING", "OBSERVING"] as const) {
      expect(canTransition(s, "OPTED_OUT")).toBe(true);
      expect(canTransition(s, "DISPUTED")).toBe(true);
    }
  });

  it("makes terminals absorbing", () => {
    expect(canTransition("RECOVERED", "DIAGNOSING")).toBe(false);
    expect(canTransition("OPTED_OUT", "EXECUTING")).toBe(false);
    expect(isTerminal("RECOVERED")).toBe(true);
  });

  it("treats incident suppression as non-terminal", () => {
    expect(isTerminal("SUPPRESSED_BY_INCIDENT")).toBe(false);
    expect(canTransition("SUPPRESSED_BY_INCIDENT", "SCHEDULED")).toBe(true);
  });
});
