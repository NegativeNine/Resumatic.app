const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAULT = /^[0-9a-f]{64}$/i;
const WORKFLOWS = {
  distill: "sources",
  tailor: "resumes",
  refine: "documents",
  letter: "documents",
  prep: "documents",
  questions: "documents",
  reembed: "reembeddings",
};
/** Validate the actual pre-deletion ledger rows, not a caller-supplied completeness flag. */
export function deletionProbeInput(manifest, base) {
  if (
    !manifest ||
    !VAULT.test(manifest.vaultId ?? "") ||
    typeof manifest.userId !== "string" ||
    !manifest.userId ||
    manifest.userId.length > 100 ||
    manifest.base !== base ||
    manifest.deletionRequested !== true ||
    !Array.isArray(manifest.sources) ||
    !manifest.sources.length ||
    !manifest.sources.every((id) => UUID.test(id)) ||
    !Array.isArray(manifest.resumes) ||
    !manifest.resumes.length ||
    !manifest.resumes.every((id) => UUID.test(id)) ||
    !Array.isArray(manifest.runs) ||
    !manifest.runs.length ||
    manifest.runs.length >= 100
  )
    throw new Error("INVALID_DELETION_MANIFEST");
  const groups = { sources: [], resumes: [], documents: [], reembeddings: [] };
  const seen = new Set();
  for (const run of manifest.runs) {
    if (
      !run ||
      !UUID.test(run.id ?? "") ||
      !UUID.test(run.targetId ?? "") ||
      seen.has(run.id) ||
      (run.kind !== "embed" && !Object.hasOwn(WORKFLOWS, run.kind))
    )
      throw new Error("INVALID_RUN_INVENTORY");
    seen.add(run.id);
    if (run.kind !== "embed") groups[WORKFLOWS[run.kind]].push(run.id);
  }
  if (
    !manifest.sources.every((source) =>
      manifest.runs.some(
        (run) => run.kind === "distill" && run.targetId === source,
      ),
    ) ||
    !manifest.resumes.every((resume) =>
      manifest.runs.some(
        (run) => run.kind === "tailor" && run.targetId === resume,
      ),
    )
  ) {
    throw new Error("INCOMPLETE_RUN_INVENTORY");
  }
  return { userId: manifest.userId, ...groups };
}
/** The protected server must disclose the coverage and count of checked IDs. */
export function workflowCoverage(response, input) {
  const expected =
    input.sources.length +
    input.resumes.length +
    input.documents.length +
    input.reembeddings.length;
  if (
    !response ||
    response.scope !== "supplied_ids_only" ||
    response.checked !== expected ||
    response.complete !== false
  ) {
    throw new Error("INVALID_WORKFLOW_COVERAGE");
  }
  // A caller's pre-deletion snapshot cannot prove that no other run existed or raced deletion.
  return { scope: response.scope, checked: expected, complete: false };
}
