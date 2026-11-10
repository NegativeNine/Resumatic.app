import { Unzip, UnzipInflate } from "fflate";
import { SaxesParser } from "saxes";
import { AppError } from "../shared/errors";

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAX_XML_BYTES = 2_000_000;

/** Preserve Word paragraph boundaries, which delimit the verifier's evidence. */
export function docxText(bytes: Uint8Array): string {
  try {
    if (bytes.length > 20_000_000) throw new Error("archive limit");
    const chunks: Uint8Array[] = [];
    let size = 0, found = false, finished = false;
    const zip = new Unzip((file) => {
      if (file.name !== "word/document.xml") return;
      if (found || (file.originalSize ?? 0) > MAX_XML_BYTES) throw new Error("document limit");
      found = true;
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        size += chunk.length;
        if (size > MAX_XML_BYTES) throw new Error("document limit");
        chunks.push(chunk);
        finished = final;
      };
      file.start();
    });
    zip.register(UnzipInflate);
    for (let at = 0; at < bytes.length; at += 1024)
      zip.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length);
    if (!found || !finished) throw new Error("missing document");
    const xml = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { xml.set(chunk, at); at += chunk.length; }
    const output: string[] = [];
    let inText = false;
    const parser = new SaxesParser({ xmlns: true });
    parser.on("doctype", () => { throw new Error("document type"); });
    parser.on("opentag", (tag) => {
      if (tag.uri !== WORD) return;
      if (tag.local === "t") inText = true;
      if (tag.local === "tab") output.push("\t");
      if (tag.local === "br" || tag.local === "cr") output.push("\n");
    });
    parser.on("text", (text) => { if (inText) output.push(text); });
    parser.on("closetag", (tag) => {
      if (tag.uri !== WORD) return;
      if (tag.local === "t") inText = false;
      if (tag.local === "p") output.push("\n");
    });
    parser.write(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(xml)).close();
    return output.join("").trim();
  } catch {
    throw new AppError("invalid", "This file couldn't be read. Try a Word file (.docx) or a PDF with selectable text.");
  }
}
