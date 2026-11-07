import { describe, expect, it } from "vitest";
import {
  count,
  formatBytes,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDayMonthAfter,
  formatMonth,
  formatMonthAfter,
} from "../../src/web/format";

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

  it("gives the first day of the next month, across a year end", () => {
    expect(formatMonthAfter("2026-11")).toBe("1 Dec 2026");
    expect(formatMonthAfter("2026-12")).toBe("1 Jan 2027");
    expect(formatDayMonthAfter("2026-11")).toBe("1 Dec");
    expect(formatMonthAfter("soon")).toBeNull();
    expect(formatMonthAfter("2026-13")).toBeNull();
  });

  it("shows dates and times as the voice guide writes them, in any locale", () => {
    const morning = new Date(2026, 10, 7, 9, 42).getTime();
    const evening = new Date(2026, 10, 7, 21, 5).getTime();
    const midnight = new Date(2026, 10, 7, 0, 15).getTime();
    expect(formatDate(morning)).toBe("7 Nov 2026");
    expect(formatDateTime(morning)).toBe("7 Nov 2026, 9:42 AM");
    expect(formatDateTime(evening)).toBe("7 Nov 2026, 9:05 PM");
    expect(formatDateTime(midnight)).toBe("7 Nov 2026, 12:15 AM");
    expect(formatDate(morning / 1000)).toBe("7 Nov 2026");
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
