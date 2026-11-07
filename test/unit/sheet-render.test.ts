import { describe, expect, it } from "vitest";
import type { Profile, ResumeBody } from "../../src/shared/api";
import { formatRoleDates, sheetLines, sheetModel } from "../../src/shared/sheet";
import { renderResumeHtml } from "../../src/render/template";

const profile: Profile = {
  name: "Sam Rivera",
  email: "sam.rivera@example.com",
  phone: "",
  location: "Waterloo, ON",
  links: ["linkedin.com/in/samrivera", "github.com/sam<rivera>"],
};

const line = (id: string, text: string) => ({ id, text, factIds: [`fact-${id}`], status: "kept" as const });

const body: ResumeBody = {
  summary: line("summary", "Backend engineer who builds data pipelines & moves services to Kubernetes."),
  sections: [
    {
      roleId: "northwind",
      kind: "job",
      org: "Northwind Logistics",
      title: "Senior Backend Engineer",
      startDate: "2021-03",
      endDate: null,
      lines: [line("a", "• Led the migration of 40 services\n  from Heroku to Kubernetes."), line("b", "Cut p95 latency to 210 ms.")],
    },
    { roleId: "uw", kind: "education", org: "University of Waterloo", title: "BASc, Computer Engineering", startDate: "2014-09", endDate: "2018-04", lines: [] },
    { roleId: "oss", kind: "project", org: "Open Telemetry", title: null, startDate: "2019", endDate: "2020", lines: [line("c", "Maintained the Kafka exporter.")] },
    { roleId: "fab", kind: "volunteer", org: "Fabrikam Transit Data", title: "Volunteer", startDate: null, endDate: null, unknownEndStartDate: "2019-01", lines: [] },
  ],
  skills: ["Python", "Redis", "C++ & Rust"],
};

describe("the resume sheet model", () => {
  const model = sheetModel(profile, body);

  it("prints every role that isn't education under Experience, then Education", () => {
    expect(model.sections.map((s) => [s.heading, s.roles.map((r) => r.section.roleId)])).toEqual([
      ["Experience", ["northwind", "oss", "fab"]],
      ["Education", ["uw"]],
    ]);
  });

  it("heads each role with its title and organization, and its dates", () => {
    const [northwind, oss, fab] = model.sections[0]!.roles;
    expect(northwind).toMatchObject({ heading: "Senior Backend Engineer, Northwind Logistics", dates: "Mar 2021 – Present" });
    expect(oss).toMatchObject({ heading: "Open Telemetry", dates: "2019 – 2020" });
    expect(fab!.dates).toBe("Start: Jan 2019 (end unknown)");
  });

  it("keeps the contact details in order and drops the empty ones", () => {
    expect(model.name).toBe("Sam Rivera");
    expect(model.contact).toEqual(["sam.rivera@example.com", "Waterloo, ON", "linkedin.com/in/samrivera", "github.com/sam<rivera>"]);
  });

  it("presents imported bullets without their markers, and keeps the stored line", () => {
    const lines = sheetLines(model);
    expect(lines.map((l) => l.text)).toEqual([
      "Backend engineer who builds data pipelines & moves services to Kubernetes.",
      "Led the migration of 40 services from Heroku to Kubernetes.",
      "Cut p95 latency to 210 ms.",
      "Maintained the Kafka exporter.",
    ]);
    expect(lines[1]!.line.text).toBe("• Led the migration of 40 services\n  from Heroku to Kubernetes.");
  });

  it("formats dates as the template always has", () => {
    expect(formatRoleDates("2018-06", "2021-02")).toBe("Jun 2018 – Feb 2021");
    expect(formatRoleDates(null, null)).toBe("");
    expect(formatRoleDates("2021-03", null)).toBe("Mar 2021 – Present");
  });
});

describe("the PDF template", () => {
  it("prints exactly what it printed before the sheet model existed", async () => {
    const html = renderResumeHtml({ profile, body, version: 3, company: "Litware", title: "Platform Engineer" });
    await expect(html).toMatchFileSnapshot("./__snapshots__/resume-template.html");
  });
});
