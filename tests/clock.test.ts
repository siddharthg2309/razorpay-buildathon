import { describe, expect, it } from "vitest";
import { RealClock, VirtualClock, days, hours } from "@rra/core";

describe("VirtualClock", () => {
  it("advances by a duration and never rewinds", () => {
    const clock = new VirtualClock(0);
    expect(clock.now().getTime()).toBe(0);
    clock.advance(days(3));
    expect(clock.now().getTime()).toBe(259_200_000);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advanceTo(0)).toThrow(RangeError);
  });

  it("advances to an absolute instant", () => {
    const clock = new VirtualClock(new Date("2026-09-02T00:00:00Z"));
    clock.advanceTo(new Date("2026-09-16T00:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  it("compresses a 14-day sequence into instants", () => {
    const clock = new VirtualClock(0);
    const fireTimes = [hours(1), days(3), days(7), days(14)];
    const observed = fireTimes.map((t) => {
      clock.advanceTo(t);
      return clock.now().getTime();
    });
    expect(observed).toEqual(fireTimes);
  });

  it("RealClock reads wall time", () => {
    expect(new RealClock().now()).toBeInstanceOf(Date);
  });
});
