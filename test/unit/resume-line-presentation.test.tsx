import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineCard } from "../../src/web/components/jobs/LineCard";
import { lineText } from "../../src/web/components/jobs/LineMarks";
import { LineDetail } from "../../src/web/components/LineItem";
import { checkSentence } from "../../src/web/resume-check";
import { SessionContext } from "../../src/web/session";

describe("resume line presentation", () => {
  it("explains when your fact’s own words were used as a fallback", () => {
    const line = { id: "line", text: "• Built a service\n  for customers", factIds: ["fact"], status: "replaced" as const };
    const detail = createElement(LineDetail, {
      resumeId: "resume", applicationId: "job", roleId: "role", line,
      facts: { fact: { text: line.text, quote: "• Built a service\n  for customers" } },
      reload: async () => {}, readOnly: true,
    });
    const card = createElement(LineCard, {
      cardId: "card", lineId: line.id, text: lineText({ line, roleId: "role" }), presentation: "margin", editing: false,
      focusRequest: { current: false }, headingRef: createRef<HTMLHeadingElement>(), onClose: () => {},
    }, detail);
    const html = renderToStaticMarkup(createElement(SessionContext.Provider, {
      value: {
        me: {
          userId: "user",
          profile: { name: "User", email: "", phone: "", location: "", links: [] },
          quota: { used: 0, limit: 10, month: "2026-11" },
        },
        updateMe: () => {}, refreshMe: async () => {}, endSession: () => {},
      },
    }, card));
    expect(html).toContain("Your wording");
    expect(html).toContain("couldn’t be backed, so this line uses your fact’s own words");
    expect(html).toContain(">Built a service for customers</p>");
    expect(html).toContain("• Built a service\n  for customers"); // The source quote is unchanged.
    expect(line.text).toBe("• Built a service\n  for customers");
  });

  it("uses the same words in the check sentence, never the earlier label", () => {
    const line = { id: "line", text: "Built a service", factIds: ["fact"], status: "replaced" as const };
    const body = { summary: line, sections: [], skills: [] };
    const sentence = checkSentence(
      { id: "r", applicationId: "a", state: "ready", step: null, error: null, version: 2, createdAt: 0, provenance: "snapshot", body, report: null, facts: { fact: { text: "Built a service", quote: null } } },
      body,
    );
    expect(sentence).toBe("Every line is backed by your record; 1 uses your record’s own words.");
    expect(sentence).not.toContain("Replaced");
  });
});
