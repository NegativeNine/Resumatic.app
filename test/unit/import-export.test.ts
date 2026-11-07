import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { authoritativeFact, checkLine } from "../../src/grounding/verdict";
import { linkedInMarkdown, parseCsv } from "../../src/pipeline/linkedin";
import { renderDocx, textDocx } from "../../src/render/docx";
import { renderResumeHtml } from "../../src/render/template";
import type { FactRecord, RenderData } from "../../src/shared/types";

describe("LinkedIn career data import", () => {
  it("preserves quoted commas, newlines, quotes, BOM and formula-like text as literal cells", () => {
    expect(
      parseCsv(
        '\uFEFF"Company Name",Description\r\nAcme,"Built APIs, then\nsaid ""done"""\r\nOther,=SUM(A1)',
      ),
    ).toEqual([
      ["Company Name", "Description"],
      ["Acme", 'Built APIs, then\nsaid "done"'],
      ["Other", "=SUM(A1)"],
    ]);
  });
  it("rejects ambiguous or incomplete CSV rather than inventing cells", () => {
    expect(() => parseCsv('Company,Title\n"Acme"x,Engineer')).toThrow(
      "unexpected text",
    );
    expect(() => parseCsv('Company,Title\n"Acme,Engineer')).toThrow(
      "incomplete CSV",
    );
  });
  it("bounds columns, total cells, and rows before allocating an oversized CSV", () => {
    const wide = Array(256).fill("x").join(",");
    expect(parseCsv(wide)[0]).toHaveLength(256);
    expect(() => parseCsv(`${wide},x`)).toThrow("too many cells");
    expect(parseCsv("x\n".repeat(10_000))).toHaveLength(10_000);
    expect(() => parseCsv(`${"x\n".repeat(10_000)}x`)).toThrow("too many rows");
    const twoHundred = Array(200).fill("x").join(",");
    const atCellLimit = `${twoHundred}\n`.repeat(500);
    expect(parseCsv(atCellLimit)).toHaveLength(500);
    expect(() => parseCsv(`${atCellLimit}x`)).toThrow("too many cells");
  });
  it("only extracts supported career files and retains their exact cell text", () => {
    const zip = zipSync({
      "export/Positions.csv": strToU8(
        'Company Name,Title,Description\nAcme,Engineer,"Built 12 APIs, safely"',
      ),
      "Messages.csv": strToU8("Secret private-message marker"),
      "Connections.csv": strToU8("Private contact marker"),
    });
    const markdown = linkedInMarkdown(zip);
    expect(markdown).toContain("Company Name: Acme");
    expect(markdown).toContain("Description: Built 12 APIs, safely");
    expect(markdown).not.toMatch(/private-message|contact marker/i);
  });
  it("rejects traversal, duplicate career files and mismatched row headings", () => {
    expect(() =>
      linkedInMarkdown(zipSync({ "../Positions.csv": strToU8("a,b\n1,2") })),
    ).toThrow("unsafe archive path");
    expect(() =>
      linkedInMarkdown(
        zipSync({
          "a/Skills.csv": strToU8("Name\nGo"),
          "b/SKILLS.CSV": strToU8("Name\nRust"),
        }),
      ),
    ).toThrow("duplicate career files");
    expect(() =>
      linkedInMarkdown(
        zipSync({ "Positions.csv": strToU8("Company,Title\nAcme") }),
      ),
    ).toThrow("does not match");
    expect(() =>
      linkedInMarkdown(zipSync({ "Messages.csv": strToU8("ignored") })),
    ).toThrow("no supported LinkedIn");
  });
  it("checks expansion bounds before accepting compressed text", () => {
    const zip = zipSync({
      "Positions.csv": new Uint8Array(5 * 1024 * 1024 + 1),
    });
    expect(() => linkedInMarkdown(zip)).toThrow(
      "expanded archive is too large",
    );
  });
  it("rejects an oversized source as it is assembled", () => {
    const zip = zipSync({ "Skills.csv": strToU8(`Name\n${"x".repeat(59_999)}`) });
    expect(() => linkedInMarkdown(zip)).toThrow("career export is too long");
  });
});

describe("DOCX generation", () => {
  const data: RenderData = {
    profile: {
      name: "Jane <Doe>\u0001",
      email: "jane@example.test",
      phone: "",
      location: "City",
      links: [],
    },
    company: "Acme",
    title: "Engineer",
    version: 1,
    body: {
      summary: null,
      sections: [
        {
          roleId: "r1",
          kind: "job",
          org: "Acme & Co",
          title: "Engineer",
          startDate: "2021-03",
          endDate: null,
          lines: [
            {
              id: "l1",
              text: 'Built <safe> APIs & said "done" 📍',
              factIds: ["f1"],
              status: "kept",
            },
          ],
        },
      ],
      skills: ["Go", "C++"],
    },
  };
  it("produces a self-contained Word package with escaped text and heading styles", () => {
    const files = unzipSync(renderDocx(data));
    expect(Object.keys(files).sort()).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/_rels/document.xml.rels",
        "word/document.xml",
        "word/styles.xml",
      ].sort(),
    );
    const xml = strFromU8(files["word/document.xml"]!);
    expect(xml).toContain("Jane &lt;Doe&gt;�");
    expect(xml).not.toContain("\u0001");
    expect(xml).toContain(
      "Built &lt;safe&gt; APIs &amp; said &quot;done&quot; 📍",
    );
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain("Mar 2021 – Present");
    expect(strFromU8(files["word/_rels/document.xml.rels"]!)).not.toMatch(
      /TargetMode="External"|https?:\/\/[^\"]+\.com\//,
    );
  });
  it("renders the same immutable version deterministically", () => {
    expect(renderDocx(data)).toEqual(renderDocx(structuredClone(data)));
    expect(
      strFromU8(
        unzipSync(textDocx("Letter", ["Built 12 APIs."]))["word/document.xml"]!,
      ),
    ).toContain("Built 12 APIs.");
  });
  it("renders an imported bullet and soft-wrapped line once without changing the saved version", () => {
    const value = structuredClone(data);
    value.body.sections[0]!.lines[0]!.text = "- • Worked with the team and helped\nlaunch the project.";
    const html = renderResumeHtml(value);
    const xml = strFromU8(unzipSync(renderDocx(value))["word/document.xml"]!);
    expect(html).toContain("<li>Worked with the team and helped launch the project.</li>");
    expect(xml).toContain("• Worked with the team and helped launch the project.");
    expect(xml).not.toContain("• •");
    expect(value.body.sections[0]!.lines[0]!.text).toBe("- • Worked with the team and helped\nlaunch the project.");
  });
  it("preserves line breaks and tabs as Word run elements in resumes and documents", () => {
    const value = structuredClone(data);
    value.body.sections[0]!.lines[0]!.text = "Built <safe> APIs\r\nthen\tled\rwork\nfinished";
    const resume = strFromU8(unzipSync(renderDocx(value))["word/document.xml"]!);
    const letter = strFromU8(unzipSync(textDocx("Letter", ["Built <safe> APIs\r\nthen\tled\rwork\nfinished"]))["word/document.xml"]!);
    for (const xml of [resume, letter]) {
      expect(xml).toContain('Built &lt;safe&gt; APIs</w:t><w:br/><w:t xml:space="preserve">then</w:t><w:tab/><w:t xml:space="preserve">led</w:t><w:br/><w:t xml:space="preserve">work</w:t><w:br/><w:t xml:space="preserve">finished');
      expect(xml.match(/<w:br\/>/g)).toHaveLength(3);
      expect(xml.match(/<w:tab\/>/g)).toHaveLength(1);
    }
  });
  it("renders a start with unknown end without claiming the role is current", () => {
    const value = structuredClone(data);
    value.body.sections[0]!.startDate = null;
    value.body.sections[0]!.endDate = null;
    Object.assign(value.body.sections[0]!, { unknownEndStartDate: "2020" });
    const xml = strFromU8(unzipSync(renderDocx(value))["word/document.xml"]!);
    expect(xml).toContain("Start: 2020 (end unknown)");
    expect(xml).not.toContain("2020 – Present");
  });
});

describe("authoritative user corrections", () => {
  it("does not use an unproven historic user level when the corrected wording has no scope verb", () => {
    const old: FactRecord = {
      id: "historic", roleId: null, kind: "accomplishment", origin: "user",
      text: "Migration project participant", quote: null, level: "led",
    };
    const line = { roleId: null, text: "Led the migration project", factIds: [old.id] };
    expect(checkLine(line, new Map([[old.id, old]]), new Set([old.id])).ok).toBe(false);
    const confirmed = { ...old, levelExplicit: true };
    expect(checkLine(line, new Map([[old.id, confirmed]]), new Set([old.id])).ok).toBe(true);
  });
  it("does not let an old source quote or stronger old level override corrected text", () => {
    const fact: FactRecord = {
      id: "f1",
      roleId: "r1",
      kind: "accomplishment",
      origin: "user",
      text: "Helped migrate 4 services",
      quote: "Led the migration of 40 services",
      level: "led",
    };
    expect(authoritativeFact(fact)).toMatchObject({
      quote: null,
      level: "contributed",
    });
    const selected = new Set(["f1"]);
    const facts = new Map([["f1", fact]]);
    expect(
      checkLine(
        {
          roleId: "r1",
          text: "Led the migration of 40 services",
          factIds: ["f1"],
        },
        facts,
        selected,
      ).ok,
    ).toBe(false);
    expect(
      checkLine(
        { roleId: "r1", text: "Helped migrate 4 services", factIds: ["f1"] },
        facts,
        selected,
      ).ok,
    ).toBe(true);
    expect(fact.quote).toBe("Led the migration of 40 services");
  });
});
