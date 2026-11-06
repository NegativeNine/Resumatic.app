/**
 * Only an instance-specific absence is evidence that a Workflow instance is
 * gone. A generic HTTP 404 or numeric platform error can mean the Workflow
 * resource or binding itself is missing, leaving its instances unverified.
 */
export function isMissingWorkflowInstance(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // Wrangler identifies 10200 as WORKFLOW_NOT_FOUND_CODE; never interpret it
  // as proof that an individual instance was erased, even with a mixed message.
  if ("code" in error && (error.code === 10200 || error.code === "10200")) return false;
  if (!("message" in error) || typeof error.message !== "string") return false;
  return error.message === "instance.not_found" ||
    /^(?:Error: )?(?:Workflow )?instance(?: with (?:ID|id))? [^\n]{1,120} (?:not found|does not exist)\.?$/i.test(error.message);
}
