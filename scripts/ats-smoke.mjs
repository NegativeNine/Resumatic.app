#!/usr/bin/env node
// Extracts markers from real PDF/DOCX exports; reports field codes only, never document text.
import { readFile, writeFile } from "node:fs/promises";
import { checkAtsSmoke } from "./lib/ats-smoke.mjs";
const args = process.argv.slice(2),
  option = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
let report = {
  status: "pending",
  promotionEligible: false,
  reason: "INPUTS_REQUIRED",
};
try {
  const pdf = option("--pdf"),
    docx = option("--docx"),
    markers = option("--markers");
  if (!pdf || !docx || !markers) throw new Error("INPUTS_REQUIRED");
  report = await checkAtsSmoke(
    new Uint8Array(await readFile(pdf)),
    new Uint8Array(await readFile(docx)),
    JSON.parse(await readFile(markers, "utf8")),
  );
} catch (error) {
  const message =
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "SMOKE_CHECK_FAILED";
  report = { status: "pending", promotionEligible: false, reason: message };
}
if (option("--report"))
  await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
console.log(JSON.stringify(report));
process.exitCode =
  report.status === "passed" ? 0 : report.status === "failed" ? 1 : 2;
