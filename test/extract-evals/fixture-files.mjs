/** Synthetic input documents only. No file here is a recorded toMarkdown conversion. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync, zlibSync } from "fflate";
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

// A small built-in bitmap font keeps the scan fixture deterministic without a
// system font, browser, OCR engine or network service. Rows are five pixels.
const GLYPHS = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 2, 4, 8, 31], 3: [30, 1, 1, 14, 1, 1, 30],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 16, 30, 1, 1, 30],
  6: [14, 16, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 1, 14],
  "-": [0, 0, 0, 31, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 0, 12, 8], ":": [0, 12, 12, 0, 12, 12, 0],
  "%": [17, 2, 4, 8, 17, 0, 0], "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8], "#": [10, 31, 10, 10, 31, 10, 0],
  "?": [14, 17, 1, 2, 4, 0, 4], "'": [4, 4, 8, 0, 0, 0, 0],
  "/": [1, 2, 2, 4, 8, 8, 16], " ": [0, 0, 0, 0, 0, 0, 0],
};

/** A clean synthetic raster, not a realistic scan or a converted OCR result. */
export function scanPixels(text) {
  const width = 1224, height = 1584, scale = 3;
  const pixels = new Uint8Array(width * height).fill(252);
  const lines = [];
  for (const source of pdfSafe(text).toUpperCase().split(/\r?\n/)) {
    let line = "";
    for (const word of source.split(/\s+/).filter(Boolean)) {
      if (word.length > 60) throw new Error("synthetic_scan_word_too_long");
      if (line && line.length + 1 + word.length > 60) { lines.push(line); line = ""; }
      line += (line ? " " : "") + word;
    }
    lines.push(line);
  }
  if (lines.length > 45) throw new Error("synthetic_scan_page_too_long");
  for (const [row, line] of lines.entries()) {
    for (const [col, character] of [...line].entries()) {
      const glyph = GLYPHS[character] ?? GLYPHS["?"];
      for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
        if (!(glyph[y] & (1 << (4 - x)))) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          pixels[(90 + row * 30 + y * scale + dy) * width + 72 + col * 18 + x * scale + dx] = 24;
        }
      }
    }
  }
  return { width, height, pixels };
}

/** An image-only PDF, deliberately without a text layer or hidden text. */
export function scannedPdfFixture(text) {
  const { width, height, pixels } = scanPixels(text);
  const image = Buffer.from(zlibSync(pixels, { level: 6 }));
  const commands = "q 612 0 0 792 0 0 cm /Im1 Do Q";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Count 1 /Kids [5 0 R] >>", "ascii"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`, "ascii"),
      image,
      Buffer.from("\nendstream", "ascii"),
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(commands, "ascii")} >>\nstream\n${commands}\nendstream`, "ascii"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 3 0 R >> >> /Contents 4 0 R >>", "ascii"),
  ];
  const parts = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let size = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(size);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "ascii"), object, Buffer.from("\nendobj\n", "ascii")]);
    parts.push(part);
    size += part.length;
  }
  const xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "ascii"));
  return new Uint8Array(Buffer.concat(parts));
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
  // A clean image-only PDF for testing scan detection and OCR routing. The
  // reference text is known, but its offsets are not conversion gold labels.
  const scan = scannedPdfFixture(CASES[0].markdown);
  files.push({
    name: "synthetic-scan-dev.pdf",
    bytes: scan,
    meta: {
      id: "synthetic-scan-dev", split: "dev", format: "pdf", language: "en",
      layout: "image-only-single-column", pages: 1, origin: "synthetic",
      pdfTextTransform: "ascii-uppercase-raster", goldOffsets: "none",
      conversionStatus: "not-run", promotionEligible: false, sha256: sha256(scan),
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
