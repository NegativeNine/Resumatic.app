import { strFromU8, unzipSync } from "fflate";
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_XML_BYTES = 5 * 1024 * 1024;
const EXPECTED_FIELDS = [
  "name",
  "email",
  "employer",
  "title",
  "accomplishment",
  "skill",
];
const normalize = (value) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** This is a text-preservation smoke check, not an ATS product or semantic parser. */
export async function pdfText(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.byteLength > MAX_BYTES
  )
    throw new Error("PDF_SIZE_INVALID");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: Uint8Array.from(bytes),
    stopAtErrors: true,
    useSystemFonts: true,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
  });
  let doc;
  try {
    doc = await task.promise;
    if (doc.numPages < 1 || doc.numPages > 10)
      throw new Error("PDF_PAGE_LIMIT");
    const lines = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i),
        content = await page.getTextContent();
      lines.push(
        content.items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join(" "),
      );
    }
    return lines.join("\n");
  } finally {
    await task.destroy();
  }
}
const decodeXml = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_match, value) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (value in named) return named[value];
    const number =
      value[1].toLowerCase() === "x"
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value.slice(1), 10);
    if (
      !Number.isInteger(number) ||
      number <= 0 ||
      number > 0x10ffff ||
      (number >= 0xd800 && number <= 0xdfff)
    )
      throw new Error("DOCX_XML_INVALID");
    return String.fromCodePoint(number);
  });
export function docxText(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.byteLength > MAX_BYTES
  )
    throw new Error("DOCX_SIZE_INVALID");
  let matches = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      if (entry.name !== "word/document.xml") return false;
      if (++matches !== 1 || entry.originalSize > MAX_XML_BYTES)
        throw new Error("DOCX_XML_INVALID");
      return true;
    },
  });
  const document = files["word/document.xml"];
  if (matches !== 1 || !document || document.length > MAX_XML_BYTES)
    throw new Error("DOCX_XML_INVALID");
  const xml = strFromU8(document);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DOCX_XML_INVALID");
  const chunks = [
    ...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t\s*>/g),
  ].map((match) => decodeXml(match[1]));
  if (!chunks.length) throw new Error("DOCX_TEXT_MISSING");
  return chunks.join(" ");
}
export async function checkAtsSmoke(pdf, docx, markers) {
  if (!markers || typeof markers !== "object" || Array.isArray(markers))
    throw new Error("MARKERS_INVALID");
  for (const key of EXPECTED_FIELDS)
    if (
      typeof markers[key] !== "string" ||
      !markers[key].trim() ||
      markers[key].length > 300
    )
      throw new Error("MARKERS_INVALID");
  const [pdfResult, docxResult] = await Promise.all([
    pdfText(pdf),
    Promise.resolve().then(() => docxText(docx)),
  ]);
  const result = {
    status: "passed",
    promotionEligible: false,
    checks: { pdf: {}, docx: {} },
  };
  for (const [format, text] of [
    ["pdf", pdfResult],
    ["docx", docxResult],
  ]) {
    for (const field of EXPECTED_FIELDS)
      result.checks[format][field] = normalize(text).includes(
        normalize(markers[field]),
      );
    if (Object.values(result.checks[format]).some((ok) => !ok))
      result.status = "failed";
  }
  return result;
}
