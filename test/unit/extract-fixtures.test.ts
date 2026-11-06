import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CASES } from "../extract-evals/cases";
import { makeFixtures } from "../extract-evals/fixture-files.mjs";

const root = resolve("test/extract-evals/fixtures");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

describe("synthetic source document fixtures", () => {
  it.each(["dev", "holdout"] as const)("labels varied dates, ownership levels and instruction traps in %s", (split) => {
    const cases = CASES.filter((c) => c.split === split);
    const roles = cases.map((c) => c.gold.roles[0]!);
    expect(roles.some((r) => r.current === true)).toBe(true);
    expect(roles.some((r) => r.start === "2018-01" && r.end === "2020-06")).toBe(true);
    expect(roles.some((r) => r.start === "2016" && r.end === "2019")).toBe(true);
    expect(roles.some((r) => r.start === "2020" && r.end === null && r.current !== true)).toBe(true);
    expect(new Set(cases.flatMap((c) => c.gold.facts.map((f) => f.level).filter(Boolean))))
      .toEqual(new Set(["contributed", "implemented", "led", "owned", "founded"]));
    const traps = cases.flatMap((c) => c.gold.traps.map((t) => c.markdown.slice(...t.span)));
    expect(new Set(traps).size).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      for (const item of [...c.gold.facts, ...c.gold.traps]) {
        expect(item.span[0]).toBeGreaterThanOrEqual(0);
        expect(item.span[1]).toBeLessThanOrEqual(c.markdown.length);
        expect(c.markdown.slice(...item.span).trim()).not.toBe("");
      }
    }
  });
  it("includes varied occupations, additional education, languages, and individually labeled skills", () => {
    expect(new Set(CASES.map((c) => c.gold.roles[0]!.title)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(CASES.map((c) => c.meta.language))).toEqual(new Set(["en", "es", "de"]));
    expect(CASES.filter((c) => c.gold.roles.some((r) => r.kind === "education")).length).toBeGreaterThanOrEqual(4);
    for (const c of CASES) {
      const skills = c.gold.facts.filter((f) => f.kind === "skill");
      expect(skills).toHaveLength(2);
      const listStart = c.markdown.indexOf("Skills: ");
      const newline = c.markdown.indexOf("\n", listStart);
      const listEnd = newline < 0 ? c.markdown.length : newline;
      expect(listStart).toBeGreaterThanOrEqual(0);
      for (const skill of skills) {
        const text = c.markdown.slice(...skill.span);
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/[,\r\n]/);
        expect(skill.span[0]).toBeGreaterThan(listStart + "Skills: ".length - 1);
        expect(skill.span[1]).toBeLessThanOrEqual(listEnd);
      }
    }
  });
  it("reproduces every checked-in byte and marks conversion and promotion pending", () => {
    const generated = makeFixtures();
    expect(generated).toHaveLength(41);
    const manifest = JSON.parse(
      readFileSync(resolve(root, "manifest.json"), "utf8"),
    ) as {
      files: {
        name: string;
        sha256: string;
        conversionStatus: string;
        promotionEligible: boolean;
      }[];
    };
    expect(manifest.files).toHaveLength(generated.length);
    for (const fixture of generated) {
      const entry = manifest.files.find((item) => item.name === fixture.name)!;
      expect(entry).toBeDefined();
      expect(entry.conversionStatus).toBe("not-run");
      expect(entry.promotionEligible).toBe(false);
      expect(hash(readFileSync(resolve(root, fixture.name)))).toBe(
        entry.sha256,
      );
      expect(hash(fixture.bytes)).toBe(entry.sha256);
    }
  });
  it("keeps the source text, languages, traps and real Word archive structure in DOCX", () => {
    for (const c of CASES) {
      const archive = unzipSync(readFileSync(resolve(root, `${c.id}.docx`)));
      expect(archive["[Content_Types].xml"]).toBeDefined();
      expect(archive["_rels/.rels"]).toBeDefined();
      const document = strFromU8(archive["word/document.xml"]!);
      for (const line of c.markdown.split(/\r?\n/))
        expect(document).toContain(escape(line));
    }
  });
  it("can be opened and read by PDF.js", async () => {
    for (const [name, pages] of [
      ["synthetic-01.pdf", 1],
      ["synthetic-05.pdf", 1],
      ["synthetic-long-5p.pdf", 5],
    ] as const) {
      const data = new Uint8Array(readFileSync(resolve(root, name)));
      const loading = getDocument({ data, useSystemFonts: true });
      try {
        const pdf = await loading.promise;
        expect(pdf.numPages).toBe(pages);
        const text = await (await pdf.getPage(1)).getTextContent();
        expect(text.items.length).toBeGreaterThan(0);
      } finally {
        await loading.destroy();
      }
    }
  });
  it("provides valid cross-reference offsets, multi-column pages, and a five-page stress input", () => {
    for (const fixture of makeFixtures().filter((f) =>
      f.name.endsWith(".pdf"),
    )) {
      const pdf = Buffer.from(fixture.bytes).toString("ascii");
      expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
      expect([...pdf.matchAll(/\/Type \/Page\b/g)]).toHaveLength(
        fixture.meta.pages,
      );
      const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)![1]);
      expect(pdf.slice(xref, xref + 4)).toBe("xref");
      if (fixture.meta.layout === "two-column")
        expect(pdf).toContain("1 0 0 1 320 ");
    }
  });
});
