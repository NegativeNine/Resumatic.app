import { describe, expect, it, vi } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import { identityShard, shardedUserId } from "../../src/shared/operations";
import { allDirectories, directoryForUser } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";

const input: SignInInput = {
  provider: "google",
  subject: "google-subject",
  email: "candidate@example.test",
  hint: "enam",
};

function fixture(shards?: string) {
  const homes = new Map<string, number | null>();
  const identities = new Map<string, { userId: string; vaultId: string }>();
  const stubs = new Map<
    string,
    {
      name: string;
      existingIdentity: ReturnType<typeof vi.fn>;
      requireInvite: ReturnType<typeof vi.fn>;
      claimIdentityHome: ReturnType<typeof vi.fn>;
    }
  >();
  const get = (name: string) => {
    if (!stubs.has(name))
      stubs.set(name, {
        name,
        existingIdentity: vi.fn(async () => identities.get(name) ?? null),
        requireInvite: vi.fn(async () => {}),
        claimIdentityHome: vi.fn(
          async (
            provider: string,
            subject: string,
            preferred: number | null,
          ) => {
            const key = `${provider}:${subject}`;
            if (!homes.has(key)) homes.set(key, preferred);
            return homes.get(key)!;
          },
        ),
      });
    return stubs.get(name)!;
  };
  const env = {
    DIRECTORY_SHARDS: shards,
    DIRECTORY: { idFromName: (name: string) => name, get },
  } as unknown as Env;
  return { env, homes, identities, get };
}

describe("Directory shard routing", () => {
  it("keeps a legacy account on global and does not re-check its invite", async () => {
    const f = fixture("16");
    f.identities.set("global", {
      userId: crypto.randomUUID(),
      vaultId: "vault-legacy",
    });
    const result = await directoryForSignIn(f.env, {
      ...input,
      homeShard: 9,
      inviteAuthorized: true,
    });
    expect(result.directory).toBe(f.get("global"));
    expect(result.input).toEqual(input);
    expect(f.get("global").requireInvite).not.toHaveBeenCalled();
    expect(f.get("global").claimIdentityHome).not.toHaveBeenCalled();
  });

  it("finds existing shard accounts after new shard placement is disabled", async () => {
    const f = fixture("1");
    const shard = await identityShard(input.provider, input.subject);
    f.identities.set(`directory-${shard}`, {
      userId: shardedUserId(shard),
      vaultId: "vault-shard",
    });
    const result = await directoryForSignIn(f.env, input);
    expect(result.directory).toBe(f.get(`directory-${shard}`));
    expect(result.input.homeShard).toBe(shard);
    expect(f.get("global").requireInvite).not.toHaveBeenCalled();
  });

  it("authorizes new Google users centrally before claiming a shard", async () => {
    const f = fixture("16");
    const shard = await identityShard(input.provider, input.subject);
    const result = await directoryForSignIn(f.env, input);
    expect(f.get("global").requireInvite).toHaveBeenCalledWith(input.email);
    expect(f.get("global").claimIdentityHome).toHaveBeenCalledWith(
      "google",
      input.subject,
      shard,
    );
    expect(result.directory).toBe(f.get(`directory-${shard}`));
    expect(result.input).toEqual({
      ...input,
      homeShard: shard,
      inviteAuthorized: true,
    });
  });

  it("cannot bypass an invite by supplying trusted placement fields", async () => {
    const f = fixture("16");
    f.get("global").requireInvite.mockRejectedValue(new Error("not invited"));
    await expect(
      directoryForSignIn(f.env, {
        ...input,
        inviteAuthorized: true,
        homeShard: 1,
      }),
    ).rejects.toThrow("not invited");
    expect(f.get("global").claimIdentityHome).not.toHaveBeenCalled();
  });

  it("pins concurrent mixed-configuration sign-ins to the same creation home", async () => {
    const f = fixture("16");
    const disabled = { ...f.env, DIRECTORY_SHARDS: "1" };
    const [first, second] = await Promise.all([
      directoryForSignIn(f.env, input),
      directoryForSignIn(disabled, input),
    ]);
    expect(second.directory).toBe(first.directory);
    expect(second.input.homeShard).toBe(first.input.homeShard);
    expect(f.homes.size).toBe(1);
  });

  it("keeps a pending global creation on global after a flag enable", async () => {
    const f = fixture("1");
    const first = await directoryForSignIn(f.env, input);
    f.env.DIRECTORY_SHARDS = "16";
    const second = await directoryForSignIn(f.env, input);
    expect(first.directory).toBe(f.get("global"));
    expect(second.directory).toBe(first.directory);
    expect(second.input.homeShard).toBeUndefined();
  });

  it("keeps test sign-in's internal invite exemption", async () => {
    const f = fixture();
    const result = await directoryForSignIn(f.env, {
      ...input,
      provider: "test",
    });
    expect(result.directory).toBe(f.get("global"));
    expect(f.get("global").requireInvite).not.toHaveBeenCalled();
  });

  it("routes signed-in control actions by user ID and always enumerates old shards", () => {
    const f = fixture("1");
    expect(directoryForUser(f.env, crypto.randomUUID())).toBe(f.get("global"));
    expect(directoryForUser(f.env, shardedUserId(7))).toBe(
      f.get("directory-7"),
    );
    expect([...allDirectories(f.env)]).toHaveLength(17);
  });
});
