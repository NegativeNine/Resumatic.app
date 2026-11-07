import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { checkAtsSmoke } from "./lib/ats-smoke.mjs";
const markers = {
  name: "Jane Example",
  email: "jane@example.com",
  employer: "Example Corp",
  title: "Engineer",
  accomplishment: "Built Go services",
  skill: "Kubernetes",
};
function pdf(lines) {
  const content = [
    "BT",
    "/F1 11 Tf",
    "15 TL",
    "60 740 Td",
    ...lines.map(
      (s, i) => `${i ? "T* " : ""}(${s.replace(/[\\()]/g, "\\$&")}) Tj`,
    ),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const pos of offsets.slice(1))
    out += `${String(pos).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(out, "latin1"));
}
function docx(values) {
  return zipSync(
    {
      "word/document.xml": strToU8(
        `<w:document xmlns:w="x"><w:body>${values.map((v) => `<w:p><w:r><w:t>${v}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
      ),
    },
    { level: 1 },
  );
}
test("checks synthetic document text without emitting content or claiming ATS promotion", async () => {
  const report = await checkAtsSmoke(
    pdf(Object.values(markers)),
    docx(Object.values(markers)),
    markers,
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.promotionEligible, false);
  assert.equal(JSON.stringify(report).includes(markers.email), false);
});
test("reports missing markers without returning their values", async () => {
  const report = await checkAtsSmoke(
    pdf(Object.values(markers).slice(0, -1)),
    docx(Object.values(markers)),
    markers,
  );
  assert.equal(report.status, "failed");
  assert.equal(report.checks.pdf.skill, false);
  assert.equal(JSON.stringify(report).includes(markers.name), false);
});
