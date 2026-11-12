#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { httpsOrigin } from "./lib/config.mjs";

// Every table the app transfers (TRANSFER_TABLES in src/shared/operations.ts). A manifest that
// names any other table is refused, so this list has to name each of them; a test keeps the two
// in step.
export const TABLES = new Set([
  "profile",
  "preferences",
  "sources",
  "source_revisions",
  "evidence",
  "roles",
  "role_create_requests",
  "facts",
  "fact_create_requests",
  "extraction_feedback_sources",
  "extraction_feedback_facts",
  "extraction_feedback_manual",
  "applications",
  "application_create_requests",
  "resumes",
  "resume_versions",
  "documents",
  "document_versions",
  "interview_answers",
  "fact_splits",
  "fact_parts",
  "record_tags",
  "record_links",
  "coach_clients",
  "share_comments",
  // Saved answers and application kits: the owner's own words and choices. Resume and document IDs
  // move unchanged, and no row holds a vault ID, storage key or run ID.
  "saved_answers",
  "application_kits",
  "kit_questions",
  "email_notices",
]);
const vaultId = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const checksum = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Idempotent requests permit an operator to rerun the same operation after any lost response. */
export async function moveVault({
  base,
  sourceVaultId,
  operationId,
  accessId,
  accessSecret,
  copyAndCutover = false,
  fetcher = fetch,
  progress = () => {},
}) {
  if (
    !httpsOrigin(base) ||
    !vaultId(sourceVaultId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(operationId ?? "") ||
    !accessId ||
    !accessSecret
  )
    throw new Error("INVALID_MOVE_CONFIGURATION");
  // Durable Object IDs are hexadecimal and case-insensitive. Use the
  // canonical spelling for R2 prefixes and all cross-store comparisons.
  sourceVaultId = sourceVaultId.toLowerCase();
  async function request(path, body) {
    let response;
    try {
      response = await fetcher(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": accessId,
          "CF-Access-Client-Secret": accessSecret,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("MOVE_REQUEST_FAILED_RERUN_SAME_OPERATION");
    }
    if (!response.ok)
      throw new Error(`MOVE_HTTP_${response.status}_RERUN_SAME_OPERATION`);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error("INVALID_MOVE_RESPONSE");
    }
  }
  const sourcePath = `/admin/vaults/${sourceVaultId}`;
  const replacement = await request(`${sourcePath}/replacement`, {
    operationId,
  });
  const target = replacement?.targetVaultId ?? replacement?.targetId;
  if (!vaultId(target) || target.toLowerCase() === sourceVaultId)
    throw new Error("INVALID_REPLACEMENT_VAULT");
  const targetVaultId = target.toLowerCase();
  const result = { operationId, sourceVaultId, targetVaultId };
  if (!copyAndCutover)
    return {
      ...result,
      status: "fence-required",
      next: "Add both vault IDs to RESTORE_FENCE_IDS, deploy, then rerun with --copy-and-cutover.",
    };

  const manifest = await request(`${sourcePath}/transfer`, { operationId });
  if (
    manifest?.format !== 1 ||
    manifest.operationId !== operationId ||
    manifest.sourceVaultId !== sourceVaultId ||
    !Array.isArray(manifest.tables) ||
    !manifest.tables.length ||
    manifest.tables.some(
      (table) =>
        !TABLES.has(table.name) ||
        !Number.isSafeInteger(table.count) ||
        table.count < 0,
    )
  )
    throw new Error("INVALID_TRANSFER_MANIFEST");
  const targetPath = `/admin/vaults/${targetVaultId}`;
  await request(`${targetPath}/import`, { manifest });
  for (const table of manifest.tables) {
    let after = 0;
    let received = 0;
    let pages = 0;
    while (true) {
      if (++pages > 100_000) throw new Error("TRANSFER_PAGE_LIMIT");
      const page = await request(
        `${sourcePath}/transfer/${encodeURIComponent(operationId)}/${table.name}?after=${after}&limit=50`,
      );
      if (
        !page ||
        page.operationId !== operationId ||
        page.table !== table.name ||
        page.after !== after ||
        !Number.isSafeInteger(page.lastRowid) ||
        page.lastRowid < after ||
        !Array.isArray(page.rows) ||
        page.rows.length > 50 ||
        typeof page.done !== "boolean" ||
        (!page.done && page.lastRowid <= after)
      )
        throw new Error("INVALID_TRANSFER_PAGE");
      const { sha256, ...payload } = page;
      if (checksum(payload) !== sha256)
        throw new Error("TRANSFER_CHECKSUM_MISMATCH");
      received += page.rows.length;
      if (received > table.count || (page.done && received !== table.count))
        throw new Error("TRANSFER_COUNT_MISMATCH");
      await request(`${targetPath}/import-page`, { page });
      progress({
        operationId,
        table: table.name,
        rows: received,
        total: table.count,
      });
      if (page.done) break;
      after = page.lastRowid;
    }
  }
  // The server verifies the R2 copy and installs current financial/security state under the fence.
  const imported = await request(`${targetPath}/import-finish`, {
    operationId,
    sourceVaultId,
  });
  if (imported?.state !== "ready") throw new Error("IMPORT_NOT_READY");
  await request(`${sourcePath}/cutover`, { targetVaultId, operationId });
  return {
    ...result,
    status: "cutover-complete",
    next: "Verify the replacement while fenced, then remove its maintenance fence. Keep the source fenced until its deletion audit passes.",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  try {
    const result = await moveVault({
      base: process.env.APP_ORIGIN,
      sourceVaultId: arg("--source"),
      operationId: arg("--operation"),
      accessId: process.env.ACCESS_CLIENT_ID,
      accessSecret: process.env.ACCESS_CLIENT_SECRET,
      copyAndCutover: args.includes("--copy-and-cutover"),
      progress: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "cutover-complete" ? 0 : 2;
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "MOVE_FAILED";
    console.error(code);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
