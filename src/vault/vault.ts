import { DurableObject } from "cloudflare:workers";

/**
 * Data plane. One object per user, created only by the Directory, holding that
 * user's whole career record: sources, quotes, facts, vectors, applications and
 * resumes.
 *
 * M1 adds init, the session methods and the lifecycle methods; later milestones
 * add the user and Workflow calls (docs/v1-codebase-plan.md).
 */
export class Vault extends DurableObject<Env> {
  ping(): string {
    return "vault";
  }
}
