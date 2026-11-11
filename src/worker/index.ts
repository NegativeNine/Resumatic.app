import { rateLimitRequest, recordHttp, httpRoute } from "./limits";
import { checkOperationalAlerts } from "./alerts";
import { handleMcp } from "./mcp";
import { app } from "./routes";

// Every Durable Object and Workflow class must be exported from the main module.
export { Directory } from "../directory/directory";
export { Vault } from "../vault/vault";
export { PilotBudget } from "./pilot/object";
export { DistillWorkflow } from "../workflows/distill";
export { TailorWorkflow } from "../workflows/tailor";
export { FleetReembedWorkflow } from "../workflows/fleet";
export { ReembedWorkflow } from "../workflows/reembed";
export { DocumentWorkflow } from "../workflows/documents";
export { TaxonomyIndexWorkflow } from "../workflows/taxonomy-index";

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const path = new URL(request.url).pathname;
    const route = httpRoute(path);
    let response: Response;
    try {
      response =
        (await rateLimitRequest(request, env)) ??
        (await handleMcp(request, env, ctx)) ??
        (await app.fetch(request, env, ctx));
    } catch {
      // Hono rethrows non-Error values and can itself fail while classifying
      // hostile exceptions. Do not expose them to the Worker runtime logs.
      try { console.error("unhandled request failure", { code: "unexpected", route }); } catch { /* best effort */ }
      response = Response.json({ error: "internal", message: "something went wrong" }, {
        status: 500,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": path.startsWith("/share") ? "no-referrer" : "same-origin",
        },
      });
    }
    // Metrics must not turn an already completed write into an apparent
    // failure, or expose an exception from the analytics binding.
    try { recordHttp(env, { route, status: response.status, ms: Date.now() - started }); }
    catch { try { console.error("http metrics failed", { code: "unexpected" }); } catch { /* best effort */ } }
    return response;
  },
  async scheduled(_event, env) {
    await checkOperationalAlerts(env);
  },
} satisfies ExportedHandler<Env>;
