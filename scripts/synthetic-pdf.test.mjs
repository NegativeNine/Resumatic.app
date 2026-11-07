import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { makePdf } from "./lib/synthetic-pdf.mjs";

test("staging synthetic PDF exposes its actual content stream and font", async () => {
  const bytes = new Uint8Array(makePdf(["Jane Example", "Built Go services"]));
  const task = getDocument({ data: bytes, useSystemFonts: true });
  const document = await task.promise;
  try {
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    const contents = await page.getTextContent();
    const text = contents.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    assert.match(text, /Jane Example/);
    assert.match(text, /Built Go services/);
  } finally {
    await task.destroy();
  }
});
