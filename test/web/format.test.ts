import { describe, expect, it } from "vitest";
import {
  count,
  findingSentence,
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

describe("findings", () => {
  it("says what the check found, then what happened to the line", () => {
    expect(findingSentence({ kind: "numbers", values: ["40%"] }, "repaired")).toBe(
      "The draft said 40%. Your facts don’t include that number. Resumatic rewrote it once to match its facts.",
    );
    expect(findingSentence({ kind: "names", values: ["Kafka", "Flink", "Spark"] }, "replaced")).toBe(
      "The draft named Kafka, Flink and Spark. Your facts don’t mention them. This line uses your fact’s own words instead.",
    );
    expect(findingSentence({ kind: "scope", claimed: "owned", allowed: "implemented" }, "repaired")).toBe(
      "The draft said you owned it, which is more than your facts show. Resumatic rewrote it once to match its facts.",
    );
    expect(findingSentence({ kind: "citation" }, "replaced")).toBe(
      "The draft cited a fact it couldn’t use for this line. This line uses your fact’s own words instead.",
    );
    expect(findingSentence({ kind: "unsupported" }, "repaired")).toBe(
      "The check found wording its facts don’t support. Resumatic rewrote it once to match its facts.",
    );
  });

  it("stays general when a stored finding has no usable values", () => {
    expect(findingSentence({ kind: "numbers", values: [] }, "replaced")).toBe(
      "The draft used a number your facts don’t include. This line uses your fact’s own words instead.",
    );
  });
});

describe("typeset", () => {
  it("turns straight apostrophes and quotation marks into typographic ones", async () => {
    const { typeset } = await import("../../src/web/format");
    expect(typeset("The resume changed. It can't be saved.")).toBe("The resume changed. It can\u2019t be saved.");
    expect(typeset('"cv.pdf" is the engineers\' file.')).toBe("\u201ccv.pdf\u201d is the engineers\u2019 file.");
    expect(typeset("Type 'delete my account' to confirm.")).toBe("Type \u2018delete my account\u2019 to confirm.");
    expect(typeset("Nothing to change.")).toBe("Nothing to change.");
  });
});
