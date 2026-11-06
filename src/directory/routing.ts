import { AppError } from "../shared/errors";
import { requireFreshAuth } from "../shared/auth-expiry";
import { identityShard } from "../shared/operations";
import { directory, directoryByName } from "../shared/stubs";
import type { SignInInput } from "../shared/types";
import { syntheticPlacementIdentity, type PlacementAttempt } from "./placement-fence";

interface IdentityLocation {
  userId: string;
  vaultId: string;
}
type DirectoryStub = ReturnType<typeof directory> & {
  existingIdentity(
    provider: SignInInput["provider"],
    subject: string,
  ): Promise<IdentityLocation | null>;
  requireInvite(email: string): Promise<void>;
  claimIdentityHome(
    provider: SignInInput["provider"],
    subject: string,
    preferredShard: number | null,
    email: string,
    authExpiryMs?: number,
    authEpoch?: number,
  ): Promise<number | null>;
  placementEpoch(): Promise<number>;
  reservePlacementAttempt(provider: string, subject: string, preferred: number | null, expectedEpoch: number): Promise<PlacementAttempt>;
  sealPlacementAttempt(attempt: PlacementAttempt): Promise<{ userId: string | null }>;
  settlePlacementAttempt(provider: string, subject: string, attempt: PlacementAttempt, userId: string | null): Promise<void>;
  reconcileSyntheticPlacement(provider: string, subject: string): Promise<{ remaining: number }>;
};

function placementFenceEnabled(env: Env): boolean {
  const setting = env.PLACEMENT_FENCE_ENABLED;
  if (!setting || setting === "false") return false;
  if (setting !== "true" || env.ALLOW_TEST_SIGNIN !== "true" || !env.PILOT_BUDGET)
    throw new AppError("unavailable", "placement fencing requires staging configuration");
  return true;
}

/** Seal at the target before acknowledging an attempt to its global coordinator. */
export async function settleRoutedPlacement(env: Env, target: DirectoryStub, input: SignInInput): Promise<void> {
  const attempt = input.placementAttempt;
  if (!attempt) return;
  const sealed = await target.sealPlacementAttempt(attempt);
  await (directory(env) as DirectoryStub).settlePlacementAttempt(input.provider, input.subject, attempt, sealed.userId);
}

/**
 * Existing accounts keep their original Directory. A global placement claim serializes
 * creation across overlapping deployments that disagree about enabling new shards.
 */
export async function directoryForSignIn(
  env: Env,
  supplied: SignInInput,
): Promise<{ directory: DirectoryStub; input: SignInInput }> {
  // HTTP bodies and callers cannot grant themselves an invite or choose their own home.
  const input: SignInInput = {
    provider: supplied.provider,
    subject: supplied.subject,
    email: supplied.email,
    hint: supplied.hint,
    ...(supplied.authExpiryMs === undefined ? {} : { authExpiryMs: supplied.authExpiryMs }),
    ...(supplied.authEpoch === undefined ? {} : { authEpoch: supplied.authEpoch }),
  };
  if (input.authExpiryMs !== undefined) requireFreshAuth(input.authExpiryMs);
  const global = directory(env) as DirectoryStub;
  const fencedIdentity = placementFenceEnabled(env) && syntheticPlacementIdentity(input.provider, input.subject) && input.email.toLowerCase() === input.subject.toLowerCase();
  // Snapshot before any identity or invite lookup. A released synthetic claim
  // advances this coordinator-wide value atomically with the release.
  const epoch = fencedIdentity ? await global.placementEpoch() : undefined;
  const existingGlobal = await global.existingIdentity(input.provider, input.subject);
  if (existingGlobal) {
    if (fencedIdentity) await global.reconcileSyntheticPlacement(input.provider, input.subject);
    return { directory: global, input: { ...input, expectedUserId: existingGlobal.userId } };
  }
  const shard = await identityShard(input.provider, input.subject);
  const sharded = directoryByName(env, `directory-${shard}`) as DirectoryStub;
  // Check this even when shard creation is disabled; existing users must remain reachable.
  const existingSharded = await sharded.existingIdentity(input.provider, input.subject);
  if (existingSharded) {
    if (fencedIdentity) await global.reconcileSyntheticPlacement(input.provider, input.subject);
    return { directory: sharded, input: { ...input, homeShard: shard, expectedUserId: existingSharded.userId } };
  }
  if (syntheticPlacementIdentity(input.provider, input.subject) && !fencedIdentity)
    throw new AppError("unavailable", "synthetic placement requires the experimental staging gate");
  if (input.provider !== "test") await global.requireInvite(input.email);
  const configuration = env.DIRECTORY_SHARDS;
  if (configuration && !["0", "1", "16"].includes(configuration))
    throw new AppError(
      "unavailable",
      "Directory shard configuration must be 1 or 16",
    );
  const attempt = fencedIdentity
    ? await global.reservePlacementAttempt(input.provider, input.subject, configuration === "16" ? shard : null, epoch!)
    : undefined;
  const preferred = configuration === "16" ? shard : null;
  const home = attempt?.shard ?? (attempt ? null : await global.claimIdentityHome(
    input.provider, input.subject, preferred, input.email, input.authExpiryMs, input.authEpoch,
  ));
  if (home !== null && (!Number.isInteger(home) || home < 0 || home >= 16))
    throw new AppError(
      "unavailable",
      "Directory returned an invalid account home",
    );
  return {
    directory:
      home === null
        ? global
        : (directoryByName(env, `directory-${home}`) as DirectoryStub),
    input: {
      ...input,
      inviteAuthorized: true,
      ...(attempt ? { placementAttempt: attempt } : {}),
      ...(home === null ? {} : { homeShard: home }),
    },
  };
}
