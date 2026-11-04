import { isLocationHint } from "./location";

// The one place that builds Durable Object stubs, so the rule "the Directory is
// never on the data path" can be checked in a single file.

/** The control plane. Called only by sign-in, account deletion and admin routes. */
export function directory(env: Env) {
  const id = env.DIRECTORY.idFromName("global");
  const hint = env.DIRECTORY_HINT;
  return isLocationHint(hint) ? env.DIRECTORY.get(id, { locationHint: hint }) : env.DIRECTORY.get(id);
}

/** A user's vault, addressed by the ID from their verified session cookie. */
export function vault(env: Env, vaultId: string) {
  return env.VAULT.get(env.VAULT.idFromString(vaultId));
}
