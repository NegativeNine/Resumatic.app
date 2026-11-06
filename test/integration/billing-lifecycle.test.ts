import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";

describe("billing identifiers during account deletion", () => {
  it("leaves an old unknown customer creation pending without replaying a pruned key", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO meta (key,value) VALUES ('billing_customer_requested','1'), ('billing_customer_requested_at',?)",
        String(Date.now() - 86_400_000),
      );
    });
    await stub.close();
    const failure = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.billingCustomerForDeletion();
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(failure).toContain("operator reconciliation");
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT value FROM meta WHERE key = 'billing_customer_requested'")
        .toArray(),
    );
    expect(rows).toEqual([{ value: "1" }]);
  });

  it("retains a known customer on a closed vault and treats timestamp-less uncertainty as pending", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init(crypto.randomUUID());
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          "INSERT INTO meta (key,value) VALUES ('billing_customer_requested','1')",
        )
        .toArray(),
    );
    await stub.close();
    const failure = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.billingCustomerForDeletion();
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(failure).toContain("operator reconciliation");
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          "INSERT INTO meta (key,value) VALUES ('stripe_customer','cus_recovered')",
        )
        .toArray(),
    );
    expect(await stub.billingCustomerForDeletion()).toBe("cus_recovered");
  });
});
