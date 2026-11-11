import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Job preferences have no switch that keeps them from being used. What keeps them where they are
// is that nothing reads them, and this file holds that: it reads every file under src/ and says
// which may name the store, its types, its calls or its table. A new reader has to change one of
// these lists, in a change someone reviews.

// Vitest runs from the repository root.
const SRC = resolve(process.cwd(), "src");

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const sources = new Map(filesUnder(SRC).map((path) => [`src/${relative(SRC, path).split(sep).join("/")}`, readFileSync(path, "utf8")]));
/** The files under src/ whose text any of the patterns finds, in order. */
const naming = (...patterns: (string | RegExp)[]) =>
  [...sources].filter(([, text]) => patterns.some((pattern) => (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)))).map(([path]) => path).sort();

describe("what can reach job preferences", () => {
  it("is named only by its store, the Vault, the route, the web client and the card", () => {
    expect(sources.size).toBeGreaterThan(100);
    // The shared types and rule, the store, the Vault's two calls, and the table in SQL.
    expect(naming("shared/preferences", "vault/preferences", "PreferencesStore", "getPreferences", "updatePreferences", /\b(FROM|INTO|UPDATE|TABLE)\s+preferences\b/)).toEqual([
      "src/vault/preferences.ts",
      "src/vault/vault.ts",
      "src/web/api.ts",
      "src/web/components/Preferences.tsx",
      "src/web/preferences-save.ts",
      "src/worker/routes.ts",
    ]);
    // The search does find things: each name is where it is expected to be.
    expect(naming("PreferencesStore")).toEqual(["src/vault/preferences.ts", "src/vault/vault.ts"]);
    expect(naming("getPreferences")).toEqual(["src/vault/vault.ts", "src/worker/routes.ts"]);
    expect(naming("updatePreferences")).toEqual(["src/vault/vault.ts", "src/web/api.ts", "src/web/components/Preferences.tsx", "src/worker/routes.ts"]);

    // The table's SQL is the store's alone, however a statement might be written: by the table's
    // name after a keyword, quoted or joined, or by any of its columns.
    const store = ["src/vault/preferences.ts"];
    expect(naming(/\b(FROM|INTO|UPDATE|TABLE|JOIN)\s+["`[]?preferences\b/)).toEqual(store);
    expect(naming(/\b(pay_amount|pay_currency|pay_period|job_types|available_from)\b/)).toEqual(store);
    // One place builds the store, and the schema is the only other file that takes anything from it.
    expect(naming("new PreferencesStore(")).toEqual(["src/vault/vault.ts"]);
    expect(naming("PREFERENCES_MIGRATIONS")).toEqual(["src/vault/preferences.ts", "src/vault/schema.ts"]);
    // What loads with every page, and what heads every resume, have no field for any of it.
    const contract = sources.get("src/shared/api.ts")!;
    for (const name of ["Me", "Profile"]) {
      const start = contract.indexOf(`export interface ${name} {`);
      expect(start, name).toBeGreaterThan(-1);
      expect(contract.slice(start, contract.indexOf("\n}", start)), name).not.toMatch(/preferences|payFloor|jobTypes|availableFrom|\bplace\b/i);
    }
  });

  it("is reached in the Vault by its two owner methods and the export alone", () => {
    const vault = sources.get("src/vault/vault.ts")!.split("\n");
    const reaches = vault.flatMap((line, index) => (/\bthis\.preferences\b/.test(line) ? [index] : []));
    expect(reaches).toHaveLength(3);
    // Each is inside one of three methods, found by the nearest method heading above it.
    const heading = /^  (?:(?:private|protected|public|static|async|get|set) )*([A-Za-z_]\w*)\(/;
    const within = reaches.map((index) => {
      for (let line = index; line >= 0; line--) {
        const name = heading.exec(vault[line]!)?.[1];
        if (name) return name;
      }
      return "nowhere";
    });
    expect(within.sort()).toEqual(["exportSnapshot", "getPreferences", "updatePreferences"]);
    // So not in what loads with every page, nor in anything a copy, a connected app or a run is given.
    expect(within).not.toContain("me");
    // Both calls are the owner's: the check comes before the store is touched.
    for (const method of ["getPreferences", "updatePreferences"]) {
      const start = vault.findIndex((line) => heading.exec(line)?.[1] === method);
      const body = vault.slice(start + 1, vault.findIndex((line, index) => index > start && line === "  }"));
      expect(body[0]?.trim(), method).toBe("this.requireOwner(who);");
    }
  });

  it("is read in the web app by its own card, and by nothing that lists or ranks jobs", () => {
    // The client's two functions are called from the card and its form alone.
    expect(naming(/\bapi\.preferences\b/)).toEqual(["src/web/components/Preferences.tsx"]);
    expect(naming(/\bapi\.updatePreferences\b/)).toEqual(["src/web/components/Preferences.tsx"]);
    // The route is written out in the client, and in the contract's list of routes, and nowhere else.
    expect(naming("/api/preferences")).toEqual(["src/shared/api.ts", "src/web/api.ts"]);
    expect(naming('"/preferences"')).toEqual(["src/worker/routes.ts"]);
    // The card is put on one page.
    expect(naming("JobPreferences")).toEqual(["src/web/components/Preferences.tsx", "src/web/pages/AccountPage.tsx"]);
    expect(naming("preferences-save")).toEqual(["src/web/components/Preferences.tsx"]);
  });
});
