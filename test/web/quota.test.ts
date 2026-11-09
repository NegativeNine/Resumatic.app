import { describe, expect, it } from "vitest";
import { quotaTicks, quotaWords } from "../../src/web/components/QuotaMeter";

const month = "2026-11";

describe("quotaWords", () => {
  it("counts outputs used this month", () => {
    expect(quotaWords({ used: 12, limit: 20, month })).toEqual({ full: false, text: "12 of 20 outputs used this month" });
  });

  it("says when the allowance comes back once it’s used up", () => {
    expect(quotaWords({ used: 20, limit: 20, month })).toEqual({ full: true, text: "20 of 20 used. More from 1 Dec" });
    expect(quotaWords({ used: 2, limit: 2, month: "2026-12" }).text).toBe("2 of 2 used. More from 1 Jan");
  });

  it("counts outputs in progress, which hold their place in the allowance", () => {
    expect(quotaWords({ used: 12, limit: 20, reserved: 2, month }).text).toBe("12 of 20 outputs used this month, 2 in progress");
    expect(quotaWords({ used: 19, limit: 20, reserved: 1, month })).toEqual({
      full: true,
      text: "19 of 20 used, 1 in progress. More from 1 Dec",
    });
  });

  it("uses a paid plan’s renewal date instead of the calendar month", () => {
    const periodEnd = new Date(2026, 10, 18, 12).getTime();
    expect(quotaWords({ used: 3, limit: 50, month, periodEnd }).text).toBe("3 of 50 outputs used until 18 Nov");
    expect(quotaWords({ used: 50, limit: 50, month, periodEnd }).text).toBe("50 of 50 used. More from 18 Nov");
  });
});

describe("quotaTicks", () => {
  it("draws a tick per output, filled as they’re used", () => {
    const ticks = quotaTicks({ used: 3, limit: 5, reserved: 1, month });
    expect(ticks).toEqual(["used", "used", "used", "reserved", "free"]);
  });

  it("draws ten ticks that each stand for a tenth above 40", () => {
    const ticks = quotaTicks({ used: 50, limit: 100, month });
    expect(ticks).toHaveLength(10);
    expect(ticks.filter((t) => t === "used")).toHaveLength(5);
  });

  it("never draws more filled ticks than there are", () => {
    expect(quotaTicks({ used: 30, limit: 20, reserved: 5, month }).every((t) => t === "used")).toBe(true);
    expect(quotaTicks({ used: 0, limit: 0, month })).toEqual([]);
  });
});
