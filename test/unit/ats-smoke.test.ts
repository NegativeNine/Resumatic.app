import { describe, expect, it } from "vitest";
import { renderDocx } from "../../src/render/docx";
import { docxText } from "../../scripts/lib/ats-smoke.mjs";

describe("synthetic Word export text smoke", () => {
  it("recovers the actual renderer's names, roles, factual lines, and symbols", () => {
    const docx = renderDocx({
      profile: {
        name: "Jane Example",
        email: "jane@example.com",
        phone: "",
        location: "",
        links: [],
      },
      body: {
        summary: null,
        sections: [
          {
            roleId: "r",
            kind: "job",
            org: "Example & Co",
            title: "Engineer",
            startDate: "2021-03",
            endDate: null,
            lines: [
              {
                id: "l",
                text: "Built Go services",
                factIds: ["f"],
                status: "kept",
              },
            ],
          },
        ],
        skills: ["Kubernetes"],
      },
      version: 1,
      company: null,
      title: null,
    });
    const text = docxText(docx);
    for (const expected of [
      "Jane Example",
      "jane@example.com",
      "Example & Co",
      "Engineer",
      "Built Go services",
      "Kubernetes",
    ])
      expect(text).toContain(expected);
  });
});
