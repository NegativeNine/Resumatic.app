import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SharedView } from "../../src/shared/sharing";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
function view(startDate: string | null, endDate: string | null): SharedView {
  return {
    grantId: "g1",
    expiresAt: Date.UTC(2027, 0, 1),
    snapshot: {
      schemaVersion: 1,
      createdAt: Date.UTC(2026, 0, 1),
      facts: [],
      resumes: [
        {
          id: "resume",
          version: 1,
          profile: {
            name: "Jane",
            email: "",
            phone: "",
            location: "",
            links: [],
          },
          summary: null,
          sections: [
            {
              id: "role",
              kind: "job",
              org: "Acme",
              title: "Engineer",
              startDate,
              endDate,
              lines: [],
            },
          ],
          skills: [],
          verification: "verified",
        },
      ],
    },
  };
}
describe("shared resume dates", () => {
  it("does not invent a current date for a role with no dates", () => {
    const html = renderToStaticMarkup(
      createElement(ShareSnapshotContent, { view: view(null, null) }),
    );
    expect(html).toContain("Acme");
    expect(html.toLowerCase()).not.toContain("present");
  });
  it("renders a current period when a start date is explicitly recorded", () => {
    const html = renderToStaticMarkup(
      createElement(ShareSnapshotContent, { view: view("2021", null) }),
    );
    expect(html).toContain("2021 – present");
  });
});
