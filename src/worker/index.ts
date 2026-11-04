import { app } from "./routes";

// Every Durable Object and Workflow class must be exported from the main module.
export { Directory } from "../directory/directory";
export { Vault } from "../vault/vault";
export { DistillWorkflow } from "../workflows/distill";
export { TailorWorkflow } from "../workflows/tailor";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
