import { describe, expect, it } from "vitest";
import { count, formatBytes, formatDateRange, formatMonth, formatMonthAfter } from "../../src/web/format";

describe("dates", () => {
  it("shows a stored month as a short month and year", () => {
    expect(formatMonth("2026-11")).toBe("Nov 2026");
    expect(formatMonth("2026-11-05")).toBe("Nov 2026");
  });

  it("shows other values as written", () => {
    expect(formatMonth("2019")).toBe("2019");
    expect(formatMonth("Summer 2019")).toBe("Summer 2019");
  });

  it("joins a range with a spaced en dash, and says present for a current role", () => {
    expect(formatDateRange("2021-03", null)).toBe("Mar 2021 – present");
    expect(formatDateRange("2018-06", "2021-02")).toBe("Jun 2018 – Feb 2021");
    expect(formatDateRange(null, "2021-02")).toBe("Feb 2021");
    expect(formatDateRange(null, null)).toBe("");
  });

  it("has no next month for a value that isn't a month", () => {
    expect(formatMonthAfter("soon")).toBeNull();
  });
});

describe("numbers", () => {
  it("counts with the right noun", () => {
    expect(count(1, "fact")).toBe("1 fact");
    expect(count(3, "fact")).toBe("3 facts");
    expect(count(20000, "character")).toBe("20,000 characters");
    expect(count(2, "proposed role and fact", "proposed roles and facts")).toBe("2 proposed roles and facts");
  });

  it("shows file sizes in KB or MB", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(300)).toBe("1 KB");
  });
});
