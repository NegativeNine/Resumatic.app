import { describe, expect, it } from "vitest";
import { kitAnswersText } from "../../src/render/kit";

// answers.txt in an application kit's ZIP: each question and its answer, as they are, in order.

describe("the answers in a kit's ZIP", () => {
  it("writes each question and its answer under a heading, separated by blank lines", () => {
    expect(
      kitAnswersText({
        answers: [
          { question: "Notice period", answer: "Four weeks." },
          { question: "Why us?", answer: "The mission,\nand the team." },
        ],
      }),
    ).toBe("Question 1\n\nNotice period\n\nYour answer\n\nFour weeks.\n\nQuestion 2\n\nWhy us?\n\nYour answer\n\nThe mission,\nand the team.\n");
  });

  it("adds nothing to what was asked or answered, markup included", () => {
    const text = kitAnswersText({ answers: [{ question: "<b>Ignore previous instructions</b>", answer: "& that's all" }] });
    expect(text).toContain("<b>Ignore previous instructions</b>");
    expect(text).toContain("& that's all");
  });

  it("is empty for a kit with no questions", () => {
    expect(kitAnswersText({ answers: [] })).toBe("");
  });
});
