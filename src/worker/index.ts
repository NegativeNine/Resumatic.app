import { rateLimitRequest, recordHttp, httpRoute } from "./limits";
import { checkOperationalAlerts } from "./alerts";
import { handleMcp } from "./mcp";
import { app } from "./routes";

// Every Durable Object and Workflow class must be exported from the main module.
export { Directory } from "../directory/directory";
export { Vault } from "../vault/vault";
export { DistillWorkflow } from "../workflows/distill";
export { TailorWorkflow } from "../workflows/tailor";
export { FleetReembedWorkflow } from "../workflows/fleet";
export { ReembedWorkflow } from "../workflows/reembed";
export { DocumentWorkflow } from "../workflows/documents";

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const response =
      (await rateLimitRequest(request, env)) ??
      (await handleMcp(request, env, ctx)) ??
      (await app.fetch(request, env, ctx));
    recordHttp(env, {
      route: httpRoute(new URL(request.url).pathname),
      status: response.status,
      ms: Date.now() - started,
    });
    return response;
  },
  async scheduled(_event, env) {
    await checkOperationalAlerts(env);
  },
} satisfies ExportedHandler<Env>;
