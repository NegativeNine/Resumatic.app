import { describe, expect, it } from "vitest";
import {
  count,
  FACT_KIND_LABEL,
  findingSentence,
  formatBytes,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDayMonthAfter,
  formatMonth,
  formatMonthAfter,
  LEVEL_LABEL,
  LINE_STATUS_HINT,
  LINE_STATUS_LABEL,
  RESUME_STATE_LABEL,
  ROLE_KIND_LABEL,
  SECTION_HEADING,
  STATE_LABEL,
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
    expect(count(2, "role and fact", "roles and facts")).toBe("2 roles and facts");
  });

  it("shows file sizes in KB or MB", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(300)).toBe("1 KB");
  });
});

describe("labels", () => {
  it("names a fact's or role's state in the plain words", () => {
    expect(STATE_LABEL).toEqual({ proposed: "To check", confirmed: "Confirmed", rejected: "Left out" });
  });

  it("names what the check did to a line, and says it again in a sentence", () => {
    expect(LINE_STATUS_LABEL).toEqual({ kept: "Backed", repaired: "Corrected", replaced: "Your wording", edited: "Edited by you" });
    expect(LINE_STATUS_HINT).toEqual({
      kept: "Backed by your record as written",
      repaired: "Rewritten once to match its facts",
      replaced: "The draft’s wording couldn’t be backed, so this line uses your fact’s own words",
      edited: "Changed by you",
    });
  });

  it("names a fact's kind as a person would", () => {
    expect(FACT_KIND_LABEL).toEqual({ accomplishment: "Something you did", skill: "A skill", credential: "A credential" });
  });

  it("leaves the labels that already used the plain words as they were", () => {
    expect(RESUME_STATE_LABEL).toEqual({ running: "Tailoring…", ready: "Ready", failed: "Failed" });
    expect(ROLE_KIND_LABEL).toEqual({ job: "Job", education: "Education", project: "Project", volunteer: "Volunteering" });
    expect(SECTION_HEADING).toEqual({ job: "Experience", education: "Education", project: "Projects", volunteer: "Volunteering" });
    expect(LEVEL_LABEL).toEqual({ contributed: "Contributed", implemented: "Implemented", led: "Led", owned: "Owned", founded: "Founded" });
  });
});

describe("findings", () => {
  const REPAIRED = "Resumatic rewrote the line to match.";
  const REPLACED = "This line uses your fact’s own words instead.";

  it("says what the check found, then what happened to the line", () => {
    expect(findingSentence({ kind: "numbers", values: ["40%"] }, "repaired")).toBe(
      `The draft said 40%. Your record doesn’t include that number. ${REPAIRED}`,
    );
    expect(findingSentence({ kind: "numbers", values: ["40%", "3x"] }, "replaced")).toBe(
      `The draft said 40% and 3x. Your record doesn’t include those numbers. ${REPLACED}`,
    );
    expect(findingSentence({ kind: "names", values: ["Kafka"] }, "repaired")).toBe(
      `The draft named Kafka. Your record doesn’t mention it. ${REPAIRED}`,
    );
    expect(findingSentence({ kind: "names", values: ["Kafka", "Flink", "Spark"] }, "replaced")).toBe(
      `The draft named Kafka, Flink and Spark. Your record doesn’t mention them. ${REPLACED}`,
    );
    expect(findingSentence({ kind: "scope", claimed: "owned", allowed: "implemented" }, "repaired")).toBe(
      `The draft said you owned it, which is more than your record shows. ${REPAIRED}`,
    );
    expect(findingSentence({ kind: "citation" }, "replaced")).toBe(
      `The draft leaned on a fact it couldn’t use for this line. ${REPLACED}`,
    );
    expect(findingSentence({ kind: "unsupported" }, "repaired")).toBe(`The check found wording your record doesn’t back. ${REPAIRED}`);
  });

  it("stays general when a stored finding has no usable values", () => {
    expect(findingSentence({ kind: "numbers", values: [] }, "replaced")).toBe(
      `The draft used a number your record doesn’t include. ${REPLACED}`,
    );
    expect(findingSentence({ kind: "names", values: [] }, "repaired")).toBe(
      `The draft named something your record doesn’t mention. ${REPAIRED}`,
    );
  });

  it("says only what was found for a line the check didn't change", () => {
    expect(findingSentence({ kind: "unsupported" }, "kept")).toBe("The check found wording your record doesn’t back.");
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
