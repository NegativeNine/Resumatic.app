import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Job preferences have no switch that keeps them from being used. What keeps them where they are
// is that nothing reads them, and this file holds that: it reads every file under src/ and says
// which may name the store, its types, its calls or its table. A new reader has to change one of
// these lists, in a change someone reviews.
//
// A list of files can't see a second reader inside a file that is already on it, and the Vault is
// such a file. It could build the store again, or call its own two owner methods with the owner's
// `who`, which requireMcp hands to every connected app's method. So for the Vault and the
// Worker's routes the lists also say how many times each way to the row is written, and in which
// method or route. Nor can it see a helper the store's module gives out beside its class, so what
// that module exports, and every statement in src/ that takes from it, are pinned too. The last
// test adds a reader in each of those ways to a copy of the sources and shows that the lists change.
//
// Everything here reads text, so a name counts wherever it is written, in a comment too.

// Vitest runs from the repository root.
const SRC = resolve(process.cwd(), "src");
const STORE = "src/vault/preferences.ts";
const VAULT = "src/vault/vault.ts";
const ROUTES = "src/worker/routes.ts";

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** The text of every file in a source tree, by its path from the repository root. */
type Tree = ReadonlyMap<string, string>;
const sources: Tree = new Map(filesUnder(SRC).map((path) => [`src/${relative(SRC, path).split(sep).join("/")}`, readFileSync(path, "utf8")]));
/** The files of a tree whose text any of the patterns finds, in order. */
const namingIn = (tree: Tree, ...patterns: (string | RegExp)[]) =>
  [...tree].filter(([, text]) => patterns.some((pattern) => (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)))).map(([path]) => path).sort();
const naming = (...patterns: (string | RegExp)[]) => namingIn(sources, ...patterns);

/** The table in a statement, however it might be written: after a keyword in either case, quoted or joined. */
const TABLE_IN_SQL = /\b(FROM|INTO|UPDATE|TABLE|JOIN)\s+["`[]?preferences\b/i;

/**
 * Every way to the row from inside the Vault or the Worker: the store's getter and its class, the
 * owner's two calls, and the owner's export, which holds the row beside everything else.
 */
const WAYS = ["this.preferences", "PreferencesStore", "getPreferences", "updatePreferences", "exportSnapshot", "exportAll", "exportJson", "exportArchiveSnapshot", "exportArchiveStream"];
/** Where a member of the Vault's class begins: its name, after any modifiers. */
const MEMBER = /^  (?:(?:private|protected|public|static|async|get|set) )*([A-Za-z_]\w*)\(/;
/** Where a route begins: its router, its verb and its path, which may be on the line below. */
const ROUTE = /^(\w+)\.(get|put|post|delete|patch|all|use)\(\s*"([^"]*)"/;
/** The place of a name written above every method or route, where the imports are. */
const ABOVE = "(above the first)";

/**
 * Where a file writes each way to the row: one place for every time the name is written, in
 * order, and no entry for a name it never writes. A place is the nearest heading at or above.
 */
function written(text: string, heading: RegExp, label: (found: RegExpExecArray) => string): Record<string, string[]> {
  const headings = [...text.matchAll(new RegExp(heading.source, "gm"))].map((found) => ({ at: found.index, label: label(found) }));
  const places: Record<string, string[]> = {};
  for (const way of WAYS) {
    const uses = [...text.matchAll(new RegExp(`\\b${way.replace(".", "\\.")}\\b`, "g"))];
    if (uses.length) places[way] = uses.map((use) => headings.findLast((heading) => heading.at <= use.index)?.label ?? ABOVE).sort();
  }
  return places;
}

/** What the store's module gives out: each line of it that exports, as written. */
const gives = (tree: Tree) => [...tree.get(STORE)!.matchAll(/^[ \t]*export\b.*$/gm)].map((line) => line[0]);
/** A statement that names a module: an import or export from it, an import of it alone, or `import(...)`. */
const SPECIFIER = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;
/**
 * Who takes anything from the store's module: every statement in a tree whose path leads to it,
 * by file, with its spaces made single. A path is followed from the file it is written in, so
 * "./preferences" counts from beside the store and not from elsewhere.
 */
function takers(tree: Tree): Record<string, string[]> {
  const module = STORE.replace(/\.ts$/, "");
  const found: Record<string, string[]> = {};
  for (const [path, text] of tree) {
    for (const statement of text.matchAll(SPECIFIER)) {
      const specifier = statement[1] ?? statement[2] ?? statement[3]!;
      if (!specifier.startsWith(".")) continue;
      const target = posix.join(posix.dirname(path), specifier).replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
      if (target === module) (found[path] ??= []).push(statement[0].replace(/\s+/g, " "));
    }
  }
  return found;
}

/** Where a tree reaches for job preferences: in the Vault by method, and in the Worker by route. */
const reach = (tree: Tree) => ({
  vault: written(tree.get(VAULT)!, MEMBER, (found) => found[1]!),
  worker: written(tree.get(ROUTES)!, ROUTE, (found) => `${found[1]}.${found[2]}("${found[3]}")`),
});

describe("what can reach job preferences", () => {
  it("is named only by its store, the Vault, the route, the web client and the card", () => {
    expect(sources.size).toBeGreaterThan(100);
    // The shared types and rule, the store, the Vault's two calls, and the table in SQL.
    expect(naming("shared/preferences", "vault/preferences", "PreferencesStore", "getPreferences", "updatePreferences", TABLE_IN_SQL)).toEqual([
      STORE,
      VAULT,
      "src/web/api.ts",
      "src/web/components/Preferences.tsx",
      "src/web/preferences-save.ts",
      ROUTES,
    ]);
    // The search does find things: each name is where it is expected to be.
    expect(naming("PreferencesStore")).toEqual([STORE, VAULT]);
    expect(naming("getPreferences")).toEqual([VAULT, ROUTES]);
    expect(naming("updatePreferences")).toEqual([VAULT, "src/web/api.ts", "src/web/components/Preferences.tsx", ROUTES]);

    // The table's SQL is the store's alone, however a statement might be written: by the table's
    // name after a keyword, quoted or joined, in either case, or by any column only it has. The
    // columns are looked for in lower case, as the store writes them: in capitals JOB_TYPES is the
    // name of the list of choices, which the form and the shared rule use too. Its other columns,
    // place, revision and updated_at, are words and columns found all over src/, so a statement
    // naming only those is found by the table's name instead (the last test shows it).
    expect(naming(TABLE_IN_SQL)).toEqual([STORE]);
    expect(naming(/\b(pay_amount|pay_currency|pay_period|job_types|available_from)\b/)).toEqual([STORE]);
    // One place builds the store, and the schema is the only other file that takes anything from it.
    expect(naming("new PreferencesStore(")).toEqual([VAULT]);
    expect(naming("PREFERENCES_MIGRATIONS")).toEqual([STORE, "src/vault/schema.ts"]);
    // The store's module gives out those two alone, and each goes to one file. A helper beside the
    // class would be allowed the table's SQL and named by no list here, so it changes these instead.
    expect(gives(sources)).toEqual(["export const PREFERENCES_MIGRATIONS: readonly string[] = [", "export class PreferencesStore {"]);
    expect(takers(sources)).toEqual({
      "src/vault/schema.ts": ['import { PREFERENCES_MIGRATIONS } from "./preferences"'],
      [VAULT]: ['import { PreferencesStore } from "./preferences"'],
    });
    // The owner's export holds the row. Only the Vault, which makes it, and the Worker, which sends it, name it.
    expect(naming(/\bexport(Snapshot|All|Json|ArchiveSnapshot|ArchiveStream)\b/)).toEqual([VAULT, ROUTES]);
    // What loads with every page, and what heads every resume, have no field for any of it.
    const contract = sources.get("src/shared/api.ts")!;
    for (const name of ["Me", "Profile"]) {
      const start = contract.indexOf(`export interface ${name} {`);
      expect(start, name).toBeGreaterThan(-1);
      expect(contract.slice(start, contract.indexOf("\n}", start)), name).not.toMatch(/preferences|payFloor|jobTypes|availableFrom|\bplace\b/i);
    }
  });

  it("is reached in the Vault by its two owner methods and the export alone", () => {
    const { vault, worker } = reach(sources);
    expect(vault).toEqual({
      // The store's getter, three times: read and saved by the owner's two calls, and read for the owner's export.
      "this.preferences": ["exportSnapshot", "getPreferences", "updatePreferences"],
      // Its class: imported, named as the getter's type, and built by the getter. Nothing builds a second store.
      PreferencesStore: [ABOVE, "preferences", "preferences"],
      // Each owner call is written once, where it is defined: the Vault never calls its own. A call
      // from a connected app's method would pass the owner check, because that method holds the owner's `who`.
      getPreferences: ["getPreferences"],
      updatePreferences: ["updatePreferences"],
      // The snapshot is taken by the three calls that give the export to its owner. Inside the
      // Vault none of the three is called, except by the call that streams the archive.
      exportSnapshot: ["exportAll", "exportArchiveSnapshot", "exportJson", "exportSnapshot"],
      exportAll: ["exportAll"],
      exportJson: ["exportJson"],
      exportArchiveSnapshot: ["exportArchiveSnapshot", "exportArchiveStream"],
      exportArchiveStream: ["exportArchiveStream"],
    });
    // So not in what loads with every page, nor in anything a copy, a connected app or a run is given.
    expect(Object.values(vault).flat()).not.toContain("me");
    // The Worker asks for each from one route: the two for preferences, and the two downloads of the export.
    expect(worker).toEqual({
      getPreferences: ['api.get("/preferences")'],
      updatePreferences: ['api.put("/preferences")'],
      exportJson: ['api.get("/export")'],
      exportArchiveStream: ['api.get("/export/archive")'],
    });

    // All three that touch the store are the owner's: the check comes before anything else.
    const lines = sources.get(VAULT)!.split("\n");
    for (const method of ["getPreferences", "updatePreferences", "exportSnapshot"]) {
      const start = lines.findIndex((line) => MEMBER.exec(line)?.[1] === method);
      const body = lines.slice(start + 1, lines.findIndex((line, index) => index > start && line === "  }"));
      expect(body[0]?.trim(), method).toBe("this.requireOwner(who);");
    }
  });

  it("is read in the web app by its own card, and by nothing that lists or ranks jobs", () => {
    // The client's two functions are called from the card and its form alone.
    expect(naming(/\bapi\.preferences\b/)).toEqual(["src/web/components/Preferences.tsx"]);
    expect(naming(/\bapi\.updatePreferences\b/)).toEqual(["src/web/components/Preferences.tsx"]);
    // The route is written out in the client, and in the contract's list of routes, and nowhere else.
    expect(naming("/api/preferences")).toEqual(["src/shared/api.ts", "src/web/api.ts"]);
    expect(naming('"/preferences"')).toEqual([ROUTES]);
    // The card is on Sharing › Recruiters alone.
    expect(naming("JobPreferences")).toEqual(["src/web/components/Preferences.tsx", "src/web/pages/sharing/SharingRecruiters.tsx"]);
    expect(naming("preferences-save")).toEqual(["src/web/components/Preferences.tsx"]);
  });

  it("gains no reader in the Vault or the Worker unseen, whichever way one reaches for the row", () => {
    /** A tree with one text that is there once in a file put in place of another. */
    const replacing = (tree: Tree, path: string, was: string, now: string): Tree => {
      const parts = tree.get(path)!.split(was);
      expect(parts, was).toHaveLength(2);
      return new Map(tree).set(path, parts.join(now));
    };
    /** The sources, or another tree, with one line added directly below a line that is there once. */
    const adding = (path: string, below: string, line: string, tree: Tree = sources): Tree => replacing(tree, path, `${below}\n`, `${below}\n${line}\n`);
    /** What the tests above hold about the Vault and the Worker's routes, read from any tree. */
    const seen = (tree: Tree) => ({ ...reach(tree), sql: namingIn(tree, TABLE_IN_SQL), gives: gives(tree), takers: takers(tree) });
    const asItIs = seen(sources);
    /** The lists as they are, but for one more place under one name. */
    const withPlace = (side: "vault" | "worker", way: string, place: string) => ({
      ...asItIs,
      [side]: { ...asItIs[side], [way]: [...asItIs[side][way]!, place].sort() },
    });
    // Where a later feature would most easily put a reader: a connected app's method, at the line
    // where it already uses the `who` that requireMcp gave it; what loads with every page; and
    // that page's route.
    const TOOL = "    const jobs = await this.listApplications(who);";
    const PAGE = "  async me(who: Who): Promise<Me> {";
    const PAGE_ROUTE = 'api.get("/me", async (c) => {';

    // Through the store's getter, the one way this file counted from the start.
    expect(seen(adding(VAULT, PAGE, "    const wanted = this.preferences.read();"))).toEqual(withPlace("vault", "this.preferences", "me"));
    // By building the store again, which names no new file and leaves the getter's count as it was.
    expect(seen(adding(VAULT, PAGE, "    const wanted = new PreferencesStore(this.sql).read();"))).toEqual(withPlace("vault", "PreferencesStore", "me"));
    // By calling the owner's own read or save, as mcpJobs calls listApplications. The owner check lets it through.
    expect(seen(adding(VAULT, TOOL, "    const wanted = await this.getPreferences(who);"))).toEqual(withPlace("vault", "getPreferences", "mcpJobs"));
    expect(seen(adding(VAULT, TOOL, "    await this.updatePreferences(who, input.wanted, 0);"))).toEqual(withPlace("vault", "updatePreferences", "mcpJobs"));
    // Out of the owner's export: from the snapshot itself, or from either call that returns it.
    expect(seen(adding(VAULT, TOOL, "    const wanted = this.exportSnapshot(who).preferences;"))).toEqual(withPlace("vault", "exportSnapshot", "mcpJobs"));
    expect(seen(adding(VAULT, TOOL, "    const wanted = (await this.exportAll(who)).preferences;"))).toEqual(withPlace("vault", "exportAll", "mcpJobs"));
    expect(seen(adding(VAULT, TOOL, "    const wanted = this.exportArchiveSnapshot(who).data.preferences;"))).toEqual(withPlace("vault", "exportArchiveSnapshot", "mcpJobs"));
    // In SQL of its own, in lower case and naming only columns that other tables have too.
    expect(seen(adding(VAULT, PAGE, "    const wanted = this.sql.exec(`select place, revision, updated_at from preferences`).toArray();"))).toEqual({ ...asItIs, sql: [STORE, VAULT] });
    // From the Worker, in the route that loads with every page: by the owner's read, or out of the export.
    expect(seen(adding(ROUTES, PAGE_ROUTE, '  const wanted = await myVault(c).getPreferences(c.get("who"));'))).toEqual(withPlace("worker", "getPreferences", 'api.get("/me")'));
    expect(seen(adding(ROUTES, PAGE_ROUTE, '  const wanted = await myVault(c).exportJson(c.get("who"));'))).toEqual(withPlace("worker", "exportJson", 'api.get("/me")'));
    // And from the Worker's server for connected apps, which authorizeMcp gives the owner's `who`
    // as requireMcp gives it to the Vault's methods. That file is on none of the lists, so naming
    // the call there is seen by the first test.
    const APPS = "src/worker/mcp.ts";
    const tool = 'const wanted = async (env: Env, claims: McpClaims) => vault(env, claims.vid).getPreferences(await localVault(env, claims.vid).authorizeMcp(claims, "vault:read"));';
    expect(namingIn(adding(APPS, "  vault(env, vid) as unknown as McpVault;", tool), "getPreferences")).toEqual([...naming("getPreferences"), APPS].sort());

    // Through a helper the store's module gives out beside its class, which reads the row with
    // SQL the store is allowed and is named by no list above. Taken by the Vault, on the line that
    // already imports the class, and called from a connected app's method.
    const HELPER = 'export function peekPreferences(sql: SqlStorage) { return sql.exec("SELECT place, pay_amount FROM preferences").toArray(); }';
    const IMPORT = 'import { PreferencesStore } from "./preferences";';
    const helper = `${sources.get(STORE)!}${HELPER}\n`;
    const given = replacing(new Map(sources).set(STORE, helper), VAULT, IMPORT, 'import { PreferencesStore, peekPreferences } from "./preferences";');
    const gained = [...asItIs.gives, HELPER];
    expect(seen(adding(VAULT, TOOL, "    const wanted = peekPreferences(this.sql);", given))).toEqual({
      ...asItIs,
      gives: gained,
      takers: { ...asItIs.takers, [VAULT]: ['import { PreferencesStore, peekPreferences } from "./preferences"'] },
    });
    // Or taken by another of the Vault's modules, by the same path, which names no list's word.
    const taken = adding("src/vault/shares.ts", 'import type { Withheld } from "./sensitive";', 'import { peekPreferences } from "./preferences";', new Map(sources).set(STORE, helper));
    expect(seen(taken)).toEqual({ ...asItIs, gives: gained, takers: { ...asItIs.takers, "src/vault/shares.ts": ['import { peekPreferences } from "./preferences"'] } });
    // Or by a path written another way, or by asking for the module while running.
    const DEEP = 'import { peekPreferences } from "../vault/./preferences.ts";';
    expect(seen(adding("src/worker/mcp.ts", "  vault(env, vid) as unknown as McpVault;", "const wanted = import(\"../vault/preferences\");")).takers["src/worker/mcp.ts"]).toEqual(['import("../vault/preferences")']);
    expect(seen(adding("src/vault/shares.ts", 'import type { Withheld } from "./sensitive";', DEEP)).takers["src/vault/shares.ts"]).toEqual([DEEP.slice(0, -1)]);
  });
});
