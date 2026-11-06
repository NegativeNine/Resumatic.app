#!/usr/bin/env node
// End-to-end check against a deployed staging Worker, with the real models, Workflows and Browser Run.
// It signs in through the staging-only test route, uploads a resume, confirms what was extracted,
// tailors a resume, downloads the PDF and the export, and deletes the account.
//
//   STAGING_URL=https://resumatic-staging.<account>.workers.dev TEST_SIGNIN_KEY=... npm run e2e:staging

import { writeFile } from "node:fs/promises";
import { validate } from "./validate-config.mjs";
import { makePdf } from "./lib/synthetic-pdf.mjs";

const missing = (await validate({ environment: "staging", purpose: "e2e" }))
  .missing;
if (missing.length) {
  const pending = {
    status: "pending",
    commit: process.env.GITHUB_SHA ?? null,
    missing,
  };
  await writeFile("e2e-report.json", JSON.stringify(pending, null, 2) + "\n", {
    mode: 0o600,
  });
  console.error(JSON.stringify(pending));
  process.exit(2);
}
const base = process.env.STAGING_URL?.replace(/\/+$/, "");
const key = process.env.TEST_SIGNIN_KEY;
if (!base || !key) {
  console.error("Set STAGING_URL and TEST_SIGNIN_KEY.");
  process.exit(2);
}

const RESUME = [
  "Jane Doe",
  "jane@example.com - Toronto",
  "",
  "EXPERIENCE",
  "Acme Corp - Senior Software Engineer (2021-03 - Present)",
  "- Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
  "- Helped design the billing API used by 3 product teams",
  "- Built a Go service that processes 2 million events per day",
  "",
  "Globex - Software Engineer (2018-06 - 2021-02)",
  "- Implemented React dashboards for the sales team",
  "- Mentored 2 junior engineers",
  "",
  "EDUCATION",
  "State University - B.S. Computer Science (2014 - 2018)",
  "",
  "SKILLS",
  "Go, TypeScript, Kubernetes, PostgreSQL",
];

const JOB = `Platform Engineer at Initrode. Run Kubernetes and deploy automation, build Go services that
handle high event volumes, design internal APIs and mentor engineers. Rust experience is a plus.`;

let cookie = "";
const started = Date.now();
const manifest = {
  base,
  userId: "",
  vaultId: "",
  sources: [],
  resumes: [],
  runs: [],
  deletionRequested: false,
};
async function saveManifest() {
  await writeFile(
    process.env.DELETION_MANIFEST_PATH ?? "deletion-manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
}

function log(step, detail = "") {
  console.log(
    `[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${step}${detail ? `: ${detail}` : ""}`,
  );
}

async function call(method, path, body, headers = {}) {
  const init = {
    method,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return fetch(base + path, init);
}

async function json(method, path, body, expected = 200) {
  const res = await call(method, path, body);
  const text = await res.text();
  if (res.status !== expected)
    throw new Error(
      `${method} ${path}: expected ${expected}, got ${res.status}`,
    );
  return text ? JSON.parse(text) : undefined;
}

async function until(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const email = `e2e-${crypto.randomUUID()}@resumatic.test`;
  const login = await call(
    "POST",
    "/auth/test-login",
    { email },
    { "x-test-signin-key": key },
  );
  if (login.status !== 204)
    throw new Error(`test sign-in failed: ${login.status}`);
  cookie =
    login.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-session="))
      ?.split(";")[0] ?? "";
  if (!cookie) throw new Error("no session cookie");
  const payload = JSON.parse(
    Buffer.from(
      cookie.slice(cookie.indexOf("=") + 1).split(".")[0],
      "base64url",
    ).toString("utf8"),
  );
  manifest.userId = payload.uid;
  manifest.vaultId = payload.vid;
  await saveManifest();
  log("signed in", manifest.userId);

  // Freeze this synthetic account's lifetime limits inside its Vault before any model calls.
  const budget = await call(
    "POST",
    "/api/test/model-budget",
    {
      maxCostMicros: Math.floor(
        Number(process.env.EVAL_BUDGET_USD) * 1_000_000,
      ),
      maxCalls: Number(process.env.EVAL_MAX_CALLS),
    },
    { "x-test-signin-key": key },
  );
  if (budget.status !== 204)
    throw new Error(`test budget could not be enforced: ${budget.status}`);

  await json("PUT", "/api/profile", {
    name: "Jane Doe",
    email: "jane@example.com",
    location: "Toronto",
  });

  const form = new FormData();
  form.set(
    "file",
    new File([makePdf(RESUME)], "jane-doe.pdf", { type: "application/pdf" }),
  );
  const { sourceId } = await json("POST", "/api/sources", form, 201);
  manifest.sources.push(sourceId);
  await saveManifest();
  log("uploaded", sourceId);

  const source = await until(
    "Distill",
    async () =>
      (await json("GET", "/api/sources")).sources.find(
        (s) => s.id === sourceId && s.state !== "queued",
      ),
    180_000,
  );
  if (source.state !== "ready") throw new Error("Distill failed");
  const { facts } = await json("GET", "/api/facts");
  const { roles } = await json("GET", "/api/roles");
  log("distilled", `${roles.length} roles, ${facts.length} facts`);
  if (facts.length < 3) throw new Error("too few facts extracted");
  if (facts.some((f) => !f.quote))
    throw new Error("an extracted fact has no quote");
  await json(
    "POST",
    "/api/review",
    {
      confirm: [...facts.map((f) => f.id), ...roles.map((r) => r.id)],
      reject: [],
    },
    204,
  );

  const { applicationId } = await json(
    "POST",
    "/api/applications",
    { jdText: JOB },
    201,
  );
  const { resumeId } = await json(
    "POST",
    `/api/applications/${applicationId}/resumes`,
    undefined,
    202,
  );
  manifest.resumes.push(resumeId);
  await saveManifest();
  log("tailoring", resumeId);
  const resume = await until(
    "Tailor",
    async () => {
      const r = await json("GET", `/api/resumes/${resumeId}`);
      return r.state !== "running" && r;
    },
    300_000,
  );
  if (resume.state !== "ready") throw new Error("Tailor failed");
  const lines = [
    resume.body.summary,
    ...resume.body.sections.flatMap((s) => s.lines),
  ].filter(Boolean);
  log("tailored", `${lines.length} lines`);
  if (lines.length === 0) throw new Error("the resume has no lines");
  for (const line of lines)
    if (!line.factIds.length) throw new Error("a line cites no facts");

  const pdf = await call("GET", `/api/resumes/${resumeId}/pdf`);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  if (pdf.status !== 200 || bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error(`PDF download failed: ${pdf.status}`);
  log("rendered PDF", `${bytes.length} bytes`);

  const exported = await json("GET", "/api/export");
  if (exported.facts.length !== facts.length)
    throw new Error("export is missing facts");
  log("exported");

  // Capture all ledger IDs before deletion. The endpoint currently returns at most 100;
  // a full page cannot establish that its result was complete.
  const inventory = await json("GET", "/api/runs");
  if (!Array.isArray(inventory.runs) || inventory.runs.length >= 100)
    throw new Error("workflow inventory is unavailable or truncated");
  manifest.runs = inventory.runs.map(({ id, kind, targetId }) => ({
    id,
    kind,
    targetId,
  }));
  await saveManifest();

  await json("DELETE", "/auth/account", undefined, 202);
  manifest.deletionRequested = true;
  await saveManifest();
  await until(
    "deletion",
    async () => [401, 410].includes((await call("GET", "/api/me")).status),
    120_000,
  );
  log("account access revoked; store erasure requires audit-deletion.mjs");
  await writeFile(
    "e2e-report.json",
    JSON.stringify(
      {
        status: "passed",
        commit: process.env.GITHUB_SHA ?? null,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        checks: {
          upload: true,
          tailor: true,
          pdf: true,
          export: true,
          accessRevoked: true,
          storageErasure: "pending",
        },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

main().catch(async (e) => {
  console.error(`E2E FAILED: ${e.message}`);
  await writeFile(
    "e2e-report.json",
    JSON.stringify(
      {
        status: "failed",
        commit: process.env.GITHUB_SHA ?? null,
        durationMs: Date.now() - started,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  if (cookie) {
    const deletion = await call("DELETE", "/auth/account").catch(() => null);
    if (deletion?.status === 202) {
      manifest.deletionRequested = true;
      await saveManifest();
    }
  }
  process.exit(1);
});
