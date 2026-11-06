#!/usr/bin/env node
// Local synthetic text-presence check; this does not exercise Browser Run or an ATS.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createServer } from "vite";
import { checkAtsSmoke } from "./lib/ats-smoke.mjs";

const browser = process.env.LOCAL_CHROME_BIN;
if (!browser || !browser.startsWith("/")) {
  console.log(JSON.stringify({ status: "pending", reason: "LOCAL_CHROME_REQUIRED", promotionEligible: false }));
  process.exitCode = 2;
} else {
  const temp = await mkdtemp(join(tmpdir(), "resumatic-render-"));
  let vite;
  try {
    vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    const { renderResumeHtml } = await vite.ssrLoadModule("/src/render/template.ts");
    const { renderDocx } = await vite.ssrLoadModule("/src/render/docx.ts");
    const data = {
      profile: { name: "Avery Example", email: "avery@example.test", phone: "555-0100", location: "Example City", links: [] },
      company: "Example Target", title: "Platform Engineer", version: 1,
      body: {
        summary: { id: "summary", text: "Built reliable software services", factIds: ["fact-1"], status: "kept" },
        sections: [{ roleId: "role-1", kind: "job", org: "Acme Example", title: "Software Engineer", startDate: "2021-03", endDate: null, lines: [{ id: "line-1", text: "Built 12 payment services", factIds: ["fact-1"], status: "kept" }] }],
        skills: ["TypeScript", "Go"],
      },
    };
    const markers = { name: "Avery Example", email: "avery@example.test", employer: "Acme Example", title: "Software Engineer", accomplishment: "Built 12 payment services", skill: "TypeScript" };
    const html = join(temp, "resume.html"), pdf = join(temp, "resume.pdf");
    await writeFile(html, renderResumeHtml(data), { mode: 0o600 });
    const run = promisify(execFile);
    // The input is fixed synthetic HTML. No user content is passed to this local process.
    await run(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, pathToFileURL(html).href], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const report = await checkAtsSmoke(new Uint8Array(await readFile(pdf)), renderDocx(data), markers);
    console.log(JSON.stringify({ ...report, renderer: "local-chromium", browserRunVerified: false }));
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ status: "pending", reason: "LOCAL_RENDER_FAILED", promotionEligible: false }));
    process.exitCode = 2;
  } finally {
    if (vite) await vite.close();
    await rm(temp, { recursive: true, force: true });
  }
}
