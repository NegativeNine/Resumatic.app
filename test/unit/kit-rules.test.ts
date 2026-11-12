import { describe, expect, it } from "vitest";
import {
  REFUSED_KIND_WORDS,
  SAVED_ANSWER_LABEL_EMPTY,
  answerKey,
  classifyDeterministic,
  cleanKitQuestions,
  cleanQuestion,
  cleanSavedAnswer,
  cleanSavedAnswerInput,
  refusedKind,
  savedLabelError,
  type RefusedKind,
} from "../../src/shared/kit";

// The pure rules of saved answers and the application kit: how a label and a question are
// compared, and the closed list of what is never saved or matched. The list is read strictly on
// purpose: an equal-opportunity form's option lines are questions of their own.

describe("the rules of saved answers", () => {
  it("answerKey folds case, apostrophes, punctuation and spacing", () => {
    expect(answerKey("  Notice   Period ")).toBe("notice period");
    expect(answerKey("NOTICE—period?!")).toBe("notice period");
    expect(answerKey("notice\tperiod\n")).toBe("notice period");
    // Every spelling of an apostrophe is taken out, so "Don't", "Don’t" and "Dont" are one.
    for (const spelling of ["Don't", "Don’t", "Don`t", "Don′t", "Dont"]) expect(answerKey(spelling), spelling).toBe("dont");
    // The same letters in another form are the same: full-width, ligatures and compatibility forms.
    expect(answerKey("ＮＯＴＩＣＥ period")).toBe("notice period");
    expect(answerKey("Ofﬁce")).toBe("office");
    // A character that isn't shown can't split a word.
    expect(answerKey("Not\u00adice pe\u200briod")).toBe("notice period");
    // Letters and digits of any script are kept.
    expect(answerKey("Préavis 30 jours")).toBe("préavis 30 jours");
    expect(answerKey("?!… —")).toBe("");
    expect(savedLabelError("?!… —")).toBe(SAVED_ANSWER_LABEL_EMPTY);
    expect(savedLabelError("Notice period")).toBeNull();
  });

  it("refusedKind catches each listed word of each kind", () => {
    for (const kind of Object.keys(REFUSED_KIND_WORDS) as RefusedKind[]) {
      for (const entry of REFUSED_KIND_WORDS[kind]) {
        // A stem with an ending, and a number where one is wanted.
        const sample = entry.replace(/\*$/, "ing").replace("#", "18");
        expect(refusedKind(sample), entry).toBe(kind);
        expect(refusedKind(`Tell us: ${sample.toUpperCase()}?`), entry).toBe(kind);
        expect(refusedKind(`${sample} - please answer`), entry).toBe(kind);
        // A stem alone counts too.
        if (entry.endsWith("*")) expect(refusedKind(entry.slice(0, -1)), entry).toBe(kind);
        // Only whole words count: a listed word inside a longer one is not that word.
        if (!entry.includes(" ") && !entry.endsWith("*")) expect(refusedKind(`zz${entry}zz`), entry).toBeNull();
      }
    }
    // Each entry is written as answerKey writes, so it can match at all.
    for (const entry of Object.values(REFUSED_KIND_WORDS).flat()) expect(answerKey(entry.replace(/\*$/, "").replace("#", "1")), entry).toBe(entry.replace(/\*$/, "").replace("#", "1"));
    // "Over" and "under" are about age only with a number after them.
    expect(refusedKind("Are you over 18?")).toBe("personal");
    expect(refusedKind("Are you over the moon?")).toBeNull();
    expect(refusedKind("Were you under pressure?")).toBeNull();
    // The first kind on the list wins.
    expect(refusedKind("Visa and salary")).toBe("work_authorisation");
    expect(refusedKind("")).toBeNull();
  });

  it("refuses each standard EEO and work-status form question and option line, on save and on match", () => {
    const lines: [string, RefusedKind][] = [
      ["Are you Hispanic or Latino?", "personal"],
      ["Please select your race:", "personal"],
      ["White", "personal"],
      ["Black or African American", "personal"],
      ["Two or more races", "personal"],
      ["Male", "personal"],
      ["Female", "personal"],
      ["Non-binary", "personal"],
      ["Decline to self-identify", "personal"],
      ["Protected veteran", "personal"],
      ["Will you require H-1B status?", "work_authorisation"],
      ["Are you on OPT?", "work_authorisation"],
      ["Expected CTC", "pay"],
      ["Do you have kids?", "personal"],
    ];
    for (const [line, kind] of lines) {
      expect(refusedKind(line), line).toBe(kind);
      // On match: a question on the list is sensitive, even when a saved answer's label is its words.
      expect(classifyDeterministic(line, [{ id: "a", labelKey: answerKey(line) }]), line).toEqual({ state: "sensitive", kind });
      // On save: as a label, or as an answer.
      expect(refusedKind(cleanSavedAnswerInput({ label: line, answer: "Yes" })!.label), line).toBe(kind);
    }
  });

  it("catches none of 'Notice period', 'Willing to relocate', 'Portfolio link', 'Years of Go experience'", () => {
    for (const line of ["Notice period", "Willing to relocate", "Portfolio link", "Years of Go experience"]) {
      expect(refusedKind(line), line).toBeNull();
      expect(classifyDeterministic(line, [{ id: "a", labelKey: answerKey(line) }]), line).toEqual({ state: "matched", savedAnswerId: "a" });
      expect(classifyDeterministic(line, []), line).toBeNull();
    }
    // The strict reading's known cost: innocent questions with these words stop and ask.
    expect(refusedKind("Which software package do you know best?")).toBe("pay");
    expect(refusedKind("Would you like to opt in to updates?")).toBe("work_authorisation");
    expect(refusedKind("Have you written a white paper?")).toBe("personal");
  });

  it("cleanQuestion removes hidden controls", () => {
    expect(cleanQuestion("  Notice\u200b\u200d period\u202e?\u0007 ")).toBe("Notice period?");
    expect(cleanQuestion("Why\r\nus?\tReally")).toBe("Why us? Really");
    expect(cleanQuestion("so\u00adft")).toBe("soft");
    // An answer keeps its lines, with every line ending one newline.
    expect(cleanSavedAnswer(" Four weeks,\r\nfrom\u2028the day\u200b I accept.\u202e ")).toBe("Four weeks,\nfrom\nthe day I accept.");
    // A save of questions takes each cleaned, and refuses an empty one, a long one, a repeated or malformed ID, or too many.
    expect(cleanKitQuestions([{ text: " Why\u200b us? " }, { id: "q1", text: "Notice period" }])).toEqual([{ id: null, text: "Why us?" }, { id: "q1", text: "Notice period" }]);
    for (const bad of [[{ text: "\u200b" }], [{ text: "x".repeat(1001) }], [{ id: "q", text: "a" }, { id: "q", text: "b" }], [{ id: "a b", text: "a" }], [{ text: "a", extra: 1 }], [1], "nope", Array.from({ length: 31 }, () => ({ text: "a" }))])
      expect(cleanKitQuestions(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
    // Half of a character pair is refused, as storage would replace it.
    expect(cleanKitQuestions([{ text: "a\ud800" }])).toBeNull();
    expect(cleanSavedAnswerInput({ label: "Notice", answer: "a\udc00" })).toBeNull();
  });
});
