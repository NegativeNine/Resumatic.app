import { strToU8, zipSync } from "fflate";
import type { RenderData } from "../shared/types";
import { formatRoleDates } from "./template";

const esc = (s: string) =>
  s
    .replace(
      /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu,
      "\ufffd",
    )
    .replace(
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
const paragraph = (text: string, style = "Normal") =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

/** Minimal standard WordprocessingML: no external relationships, tables, macros or model-generated markup. */
export function renderDocx(data: RenderData): Uint8Array<ArrayBuffer> {
  const { profile, body } = data;
  const parts = [
    paragraph(profile.name, "Title"),
    paragraph(
      [profile.email, profile.phone, profile.location, ...profile.links]
        .filter(Boolean)
        .join(" · "),
    ),
  ];
  if (body.summary) parts.push(paragraph(body.summary.text));
  for (const kind of ["experience", "education"]) {
    const roles = body.sections.filter(
      (s) => (s.kind === "education") === (kind === "education"),
    );
    if (!roles.length) continue;
    parts.push(
      paragraph(kind === "education" ? "Education" : "Experience", "Heading1"),
    );
    for (const role of roles) {
      parts.push(
        paragraph(
          [role.title, role.org].filter(Boolean).join(", "),
          "Heading2",
        ),
      );
      parts.push(
        paragraph(
          formatRoleDates(role.startDate, role.endDate, role.unknownEndStartDate),
        ),
      );
      for (const line of role.lines) parts.push(paragraph(`• ${line.text}`));
    }
  }
  if (body.skills.length)
    parts.push(
      paragraph("Skills", "Heading1"),
      paragraph(body.skills.join(" · ")),
    );
  return wordDocument(parts.join(""));
}

export function textDocx(
  title: string,
  paragraphs: string[],
): Uint8Array<ArrayBuffer> {
  return wordDocument(
    paragraph(title, "Title") + paragraphs.map((p) => paragraph(p)).join(""),
  );
}

function wordDocument(body: string): Uint8Array<ArrayBuffer> {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="864" w:right="1008" w:bottom="864" w:left="1008"/></w:sectPr></w:body></w:document>`,
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>${[
        ["Normal", 21],
        ["Title", 40],
        ["Heading1", 24],
        ["Heading2", 22],
      ]
        .map(
          ([id, size]) =>
            `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr><w:sz w:val="${size}"/>${id !== "Normal" ? "<w:b/>" : ""}</w:rPr></w:style>`,
        )
        .join("")}</w:styles>`,
    ),
  };
  return zipSync(files, {
    level: 6,
    mtime: new Date("1980-01-01T00:00:00Z"),
  }) as Uint8Array<ArrayBuffer>;
}
