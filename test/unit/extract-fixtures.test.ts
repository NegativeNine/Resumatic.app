import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync, unzlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
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
    expect(generated).toHaveLength(43);
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
  it("has a tagged document structure whose content references resolve to the intended text", async () => {
    const bytes = readFileSync(resolve(root, "synthetic-tagged-dev.pdf"));
    const fixture = makeFixtures().find((item) => item.name === "synthetic-tagged-dev.pdf")!;
    expect(fixture.meta).toMatchObject({ split: "dev", goldOffsets: "none", conversionStatus: "not-run", promotionEligible: false });
    // The page's StructParents index resolves to the five structure-element
    // references in MCID order through the document's ParentTree number tree.
    const source = bytes.toString("ascii");
    expect(source).toContain("/StructParents 0");
    expect(source).toContain("/ParentTree 16 0 R");
    expect(source).toContain("<< /Nums [0 [8 0 R 9 0 R 10 0 R 13 0 R 15 0 R]] >>");
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
      const pdf = await loading.promise;
      // The PDF.js runtime returns a Map; its published declaration says object.
      const markInfo = await pdf.getMarkInfo() as unknown as Map<string, boolean> | null;
      expect(markInfo?.get("Marked")).toBe(true);
      const page = await pdf.getPage(1);
      const content = await page.getTextContent({ includeMarkedContent: true });
      const entries: { id: string; tag: string; text: string }[] = [];
      for (const item of content.items) {
        if ("type" in item && item.type === "beginMarkedContentProps") {
          const marked = item as typeof item & { tag: string };
          entries.push({ id: marked.id!, tag: marked.tag, text: "" });
        } else if ("str" in item && entries.length) {
          entries.at(-1)!.text += item.str;
        }
      }
      expect(entries.map(({ tag, text }) => ({ tag, text }))).toEqual([
        { tag: "H1", text: "Avery Example" },
        { tag: "P", text: "Software Engineer" },
        { tag: "H2", text: "Acme Labs - Engineer - 2021 to 2024" },
        { tag: "LBody", text: "Built a deployment tool for five services." },
        { tag: "LBody", text: "Reduced deployment time by 30%." },
      ]);
      const leaf = (i: number) => ({ type: "content", id: entries[i]!.id });
      expect(await page.getStructTree()).toEqual({
        role: "Root", children: [{ role: "Document", children: [
          { role: "H1", children: [leaf(0)] },
          { role: "P", children: [leaf(1)] },
          { role: "H2", children: [leaf(2)] },
          { role: "L", children: [
            { role: "LI", children: [{ role: "LBody", children: [leaf(3)] }] },
            { role: "LI", children: [{ role: "LBody", children: [leaf(4)] }] },
          ] },
        ] }],
      });
    } finally {
      await loading.destroy();
    }
  });
  it("does not label the normal PDF fixture as tagged", async () => {
    const data = new Uint8Array(readFileSync(resolve(root, "synthetic-01.pdf")));
    const loading = getDocument({ data, useSystemFonts: true });
    try {
      const pdf = await loading.promise;
      const markInfo = await pdf.getMarkInfo() as unknown as Map<string, boolean> | null;
      expect(markInfo?.get("Marked") ?? false).toBe(false);
      expect(await (await pdf.getPage(1)).getStructTree()).toBeNull();
    } finally {
      await loading.destroy();
    }
  });
  it("contains a real image-only development PDF without selectable text", async () => {
    const bytes = readFileSync(resolve(root, "synthetic-scan-dev.pdf"));
    const header = bytes.toString("latin1");
    const object = /\/Subtype \/Image[^\n]*\/Width (\d+) \/Height (\d+)[^\n]*\/Length (\d+) >>\nstream\n/.exec(header);
    expect(object).not.toBeNull();
    const [, width, height, length] = object!;
    const imageStart = object!.index + object![0].length;
    const pixels = unzlibSync(bytes.subarray(imageStart, imageStart + Number(length)));
    expect(pixels.length).toBe(Number(width) * Number(height));
    // The image must contain ink as well as the synthetic page background.
    expect(pixels.some((pixel) => pixel < 64)).toBe(true);
    expect(pixels.some((pixel) => pixel > 240)).toBe(true);
    const fixture = makeFixtures().find((item) => item.name === "synthetic-scan-dev.pdf")!;
    expect(fixture.meta).toMatchObject({ split: "dev", goldOffsets: "none", conversionStatus: "not-run", promotionEligible: false });
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
      const pdf = await loading.promise;
      expect(pdf.numPages).toBe(1);
      const page = await pdf.getPage(1);
      expect((await page.getTextContent()).items).toHaveLength(0);
      expect((await page.getOperatorList()).fnArray).toContain(OPS.paintImageXObject);
    } finally {
      await loading.destroy();
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
