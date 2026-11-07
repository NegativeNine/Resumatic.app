import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineItem } from "../../src/web/components/LineItem";
import { ReportCard } from "../../src/web/components/ResumeReport";
import { SessionContext } from "../../src/web/session";

describe("resume line presentation", () => {
  it("explains when a verified fact was used as a fallback", () => {
    const line = { id: "line", text: "• Built a service\n  for customers", factIds: ["fact"], status: "replaced" as const };
    const lineItem = createElement(LineItem, {
      resumeId: "resume", applicationId: "job", roleId: "role", line,
      facts: { fact: { text: line.text, quote: "• Built a service\n  for customers" } },
      expanded: true, onToggle: () => {}, reload: async () => {}, readOnly: true,
    });
    const html = renderToStaticMarkup(createElement(SessionContext.Provider, {
      value: {
        me: {
          userId: "user",
          profile: { name: "User", email: "", phone: "", location: "", links: [] },
          quota: { used: 0, limit: 10, month: "2026-11" },
        },
        updateMe: () => {}, refreshMe: async () => {}, endSession: () => {},
      },
    }, lineItem));
    expect(html).toContain("Used your fact");
    expect(html).toContain("be verified, so this line uses the wording of a confirmed fact");
    expect(html).toContain(">Built a service for customers</p>");
    expect(html).toContain("• Built a service\n  for customers"); // The source quote is unchanged.
    expect(line.text).toBe("• Built a service\n  for customers");
  });

  it("uses the same fallback explanation in the report", () => {
    const html = renderToStaticMarkup(createElement(ReportCard, {
      report: { kept: 0, repaired: 0, replaced: 1, dropped: 0, gaps: [] },
    }));
    expect(html).toContain("Used your fact");
    expect(html).toContain("be verified, so this line uses the wording of a confirmed fact");
    expect(html).not.toContain(">Replaced<");
  });
});
