import { DurableObject } from "cloudflare:workers";

/**
 * Control plane. One object, reached by name, that maps sign-in identities to
 * users and users to vault IDs. It holds no career data.
 *
 * M1 adds signIn, deleteAccount, listVaults and alarm (docs/v1-codebase-plan.md).
 */
export class Directory extends DurableObject<Env> {
  ping(): string {
    return "directory";
  }
}
