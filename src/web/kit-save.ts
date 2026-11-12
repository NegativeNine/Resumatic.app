import { answerKey, cleanKitAnswer, cleanKitQuestions, cleanSavedAnswer, type KitAnswerChange, type KitPart, type KitView } from "../shared/kit";

// What the application kit panel works out without the page: whether a write landed when its
// reply was lost. A write can commit and its reply still fail, and the same write sent again is
// refused as stale, so a fresh read decides: only the kit at the next revision, holding exactly
// what was sent, counts as saved.

/** What one write to a kit sent. */
export type KitWrite =
  | { kind: "questions"; questions: { id?: string; text: string }[] }
  | { kind: "parts"; resume: KitPart | null; letter: KitPart | null; prep: KitPart | null }
  | { kind: "answer"; questionId: string; change: KitAnswerChange }
  | { kind: "approve" };

const samePart = (a: KitPart | null, b: KitPart | null) => (a === null ? b === null : b !== null && a.id === b.id && a.version === b.version);

/** Whether a fresh read shows this write landed: the kit at the next revision, holding the submitted values. */
export function kitWriteObserved(current: KitView | null | undefined, previousRevision: number, submitted: KitWrite): current is KitView {
  if (!current || !Number.isSafeInteger(previousRevision) || previousRevision < 0 || current.revision !== previousRevision + 1) return false;
  switch (submitted.kind) {
    case "questions": {
      const sent = cleanKitQuestions(submitted.questions);
      if (!sent || sent.length !== current.questions.length) return false;
      return sent.every((question, index) => {
        const held = current.questions[index]!;
        return held.text === question.text && (question.id === null || held.id === question.id);
      });
    }
    case "parts":
      return samePart(current.resume, submitted.resume) && samePart(current.letter, submitted.letter) && samePart(current.prep, submitted.prep);
    case "approve":
      return current.state === "approved";
    case "answer": {
      const question = current.questions.find((held) => held.id === submitted.questionId);
      if (!question) return false;
      const change = submitted.change;
      switch (change.kind) {
        case "confirm":
          return question.state === "matched" && question.confirmed;
        case "reject":
          return question.state === "asks" && question.typedAnswer === null;
        case "use":
          return question.state === "matched" && question.confirmed && question.savedAnswer?.id === change.savedAnswerId;
        case "type":
          return question.state !== "matched" && question.typedAnswer !== null && question.typedAnswer === cleanKitAnswer(change.answer);
        case "save":
          // The vault keeps one saved answer per folded label and returns the one already kept, so
          // its label may be written differently from the one sent.
          return (
            question.state === "matched" &&
            question.confirmed &&
            question.savedAnswer !== null &&
            answerKey(question.savedAnswer.label) === answerKey(change.label) &&
            question.savedAnswer.answer === cleanSavedAnswer(change.answer)
          );
      }
    }
  }
}
