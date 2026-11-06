import { AppError } from "../shared/errors";
import { identityShard } from "../shared/operations";
import { directory, directoryByName } from "../shared/stubs";
import type { SignInInput } from "../shared/types";

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
  ): Promise<number | null>;
};

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
  };
  const global = directory(env) as DirectoryStub;
  if (await global.existingIdentity(input.provider, input.subject))
    return { directory: global, input };
  const shard = await identityShard(input.provider, input.subject);
  const sharded = directoryByName(env, `directory-${shard}`) as DirectoryStub;
  // Check this even when shard creation is disabled; existing users must remain reachable.
  if (await sharded.existingIdentity(input.provider, input.subject))
    return { directory: sharded, input: { ...input, homeShard: shard } };
  if (input.provider !== "test") await global.requireInvite(input.email);
  const configuration = env.DIRECTORY_SHARDS;
  if (configuration && !["0", "1", "16"].includes(configuration))
    throw new AppError(
      "unavailable",
      "Directory shard configuration must be 1 or 16",
    );
  const home = await global.claimIdentityHome(
    input.provider,
    input.subject,
    configuration === "16" ? shard : null,
  );
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
      ...(home === null ? {} : { homeShard: home }),
    },
  };
}
