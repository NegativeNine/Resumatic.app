import type { KitArchiveData } from "../shared/kit";

// The answers an approved application kit holds, as plain text for its ZIP. Each question is the
// employer's words and each answer the owner's own, so they are written out as they are, with
// nothing added: a heading for each, and blank lines between.

/** "Question 1", the question, "Your answer" and the answer, for each question in order. */
export function kitAnswersText(data: Pick<KitArchiveData, "answers">): string {
  return data.answers
    .map(({ question, answer }, index) => [`Question ${index + 1}`, question, "Your answer", answer].join("\n\n"))
    .join("\n\n")
    .concat(data.answers.length ? "\n" : "");
}
