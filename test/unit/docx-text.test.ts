import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { docxText } from "../../src/pipeline/docx";
import { verifyExtraction } from "../../src/pipeline/extract/verify";

const word = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const archive = (xml: string) => zipSync({ "word/document.xml": strToU8(xml) });

describe("Word source conversion", () => {
  it("preserves paragraphs, split runs, table cells, tabs and explicit breaks", () => {
    const xml = word('<w:p><w:r><w:t>Built </w:t></w:r><w:r><w:t>tools &amp; reports</w:t><w:tab/><w:t>weekly</w:t><w:br/><w:t>for clients</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Next paragraph</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
    expect(docxText(archive(xml))).toBe("Built tools & reports\tweekly\nfor clients\nNext paragraph");
  });

  it("keeps evidence usable when flattened conversion would exceed the source-line limit", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Built reporting tools for project ${i} and documented deployment procedures for the engineering team.`);
    const raw = { roles: [], facts: paragraphs.map((quote) => ({ roleKey: null, kind: "accomplishment" as const, level: null, text: quote, quote })) };
    const text = docxText(archive(word(paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join(""))));
    expect(verifyExtraction(paragraphs.join(" "), raw).extraction.facts).toHaveLength(0);
    const verified = verifyExtraction(text, raw);
    expect(verified.extraction.facts).toHaveLength(12);
    for (const fact of verified.extraction.facts) expect(text.slice(...fact.span)).toBe(fact.quote);
  });

  it.each([
    '<!DOCTYPE w:document [<!ENTITY secret "private">]>' + word('<w:p><w:r><w:t>&secret;</w:t></w:r></w:p>'),
    word('<w:p><w:t>broken'),
    word('<w:p><w:t>' + "x".repeat(2_000_000) + '</w:t></w:p>'),
  ])("rejects unsafe, malformed or oversized XML with a fixed error", (xml) => {
    expect(() => docxText(archive(xml))).toThrow("This file couldn't be read.");
  });

  it("rejects missing document members", () => {
    expect(() => docxText(zipSync({ "other.xml": strToU8("text") }))).toThrow("This file couldn't be read.");
  });
});
