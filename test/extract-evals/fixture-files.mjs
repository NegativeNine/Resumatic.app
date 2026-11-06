/** Synthetic input documents only. No file here is a recorded toMarkdown conversion. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { CASES } from "./cases.ts";

const xml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const utf8 = (value) => strToU8(value);
const fixedMtime = new Date(1980, 0, 1, 0, 0, 0);

/** A minimal editable Word document whose paragraph text is the reference input. */
export function docxFixture(markdown) {
  const paragraphs = markdown
    .split(/\r?\n/)
    .map(
      (line) =>
        `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`,
    )
    .join("");
  return zipSync(
    {
      "[Content_Types].xml": utf8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": utf8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/document.xml": utf8(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
      ),
    },
    { level: 6, mtime: fixedMtime },
  );
}

/** PDF standard fonts are ASCII-only: the manifest explicitly records this transform. */
export function pdfSafe(text) {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/•/g, "-")
    .replace(/[^\x20-\x7e\r\n]/g, "?");
}
const pdfEscape = (text) => text.replace(/[\\()]/g, "\\$&");
/** Minimal untagged PDF; text is deliberately positioned in one or two columns. */
export function pdfFixture(pages, columns = 1) {
  const objects = [];
  const add = (value) => {
    objects.push(value);
    return objects.length;
  };
  add(""); // catalog
  add(""); // pages
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = [];
  for (const source of pages) {
    const lines = pdfSafe(source).split(/\r?\n/);
    if (lines.length > 90) throw new Error("synthetic_pdf_page_too_long");
    const midpoint = Math.ceil(lines.length / columns);
    const commands = lines
      .map((line, i) => {
        const col = Math.floor(i / midpoint),
          row = i % midpoint;
        return `BT /F1 9 Tf 1 0 0 1 ${col ? 320 : 45} ${750 - row * 14} Tm (${pdfEscape(line)}) Tj ET`;
      })
      .join("\n");
    const content = add(
      `<< /Length ${Buffer.byteLength(commands, "ascii")} >>\nstream\n${commands}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "ascii"));
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function makeFixtures() {
  const files = [];
  for (const [index, c] of CASES.entries()) {
    const columns = index % 5 === 0 ? 2 : 1;
    for (const [extension, bytes] of [
      ["docx", docxFixture(c.markdown)],
      ["pdf", pdfFixture([c.markdown], columns)],
    ]) {
      files.push({
        name: `${c.id}.${extension}`,
        bytes,
        meta: {
          id: c.id,
          split: c.split,
          format: extension,
          language: c.meta.language,
          layout:
            extension === "pdf" && columns === 2
              ? "two-column"
              : "single-column",
          pages: 1,
          origin: "synthetic",
          pdfTextTransform:
            extension === "pdf" ? "ascii-transliteration" : null,
          goldOffsets: "reference-markdown-only",
          conversionStatus: "not-run",
          promotionEligible: false,
          sha256: sha256(bytes),
        },
      });
    }
  }
  // Stress input only: it has no complete labels and must never join promotion scoring.
  const longPages = Array.from(
    { length: 5 },
    (_, i) => `# Synthetic long document — page ${i + 1}\n${CASES[i].markdown}`,
  );
  const bytes = pdfFixture(longPages);
  files.push({
    name: "synthetic-long-5p.pdf",
    bytes,
    meta: {
      id: "synthetic-long-5p",
      split: "dev",
      format: "pdf",
      language: "mixed",
      layout: "single-column",
      pages: 5,
      origin: "synthetic",
      pdfTextTransform: "ascii-transliteration",
      goldOffsets: "none",
      conversionStatus: "not-run",
      promotionEligible: false,
      sha256: sha256(bytes),
    },
  });
  return files;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dest = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
  mkdirSync(dest, { recursive: true });
  const fixtures = makeFixtures();
  for (const file of fixtures)
    writeFileSync(resolve(dest, file.name), file.bytes);
  writeFileSync(
    resolve(dest, "manifest.json"),
    JSON.stringify(
      {
        format: 1,
        files: fixtures.map(({ name, meta }) => ({ name, ...meta })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Generated ${fixtures.length} deterministic synthetic source files; no conversion has been performed.`,
  );
}
