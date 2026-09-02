import { describe, expect, it } from "vitest";
import { parseActionLibrary } from "@rra/core";

describe("action library validation", () => {
  it("rejects a capability action with no bound capability", () => {
    expect(() =>
      parseActionLibrary(`version: 1
actions:
  - id: bad
    kind: capability
`),
    ).toThrow(/must name a PSPAdapter capability/);
  });

  it("rejects a schedule action that binds a capability", () => {
    expect(() =>
      parseActionLibrary(`version: 1
actions:
  - id: bad_wait
    kind: schedule
    capability: createPaymentLink
`),
    ).toThrow(/makes no external call/);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      parseActionLibrary(`version: 1
actions:
  - id: dup
    kind: schedule
  - id: dup
    kind: schedule
`),
    ).toThrow(/duplicate action id/);
  });
});
