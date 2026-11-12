import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Saved answers and application kits have no switch that keeps them from being used. What keeps
// them where they are is that nothing reads them, and this file holds that, as the one for job
// preferences does: it reads every file under src/ and says which may name the store, its calls,
// its tables or its columns. A new reader has to change one of these lists, in a change someone
// reviews.
//
// A list of files can't see a second reader inside a file that is already on it, and the Vault is
// such a file. It could build the store again, reach it from a connected app's method, or call one
// of the owner's own methods with the `who` that requireMcp hands to every connected app's method.
// So for the Vault and the Worker's routes the lists also say where each way to the store is
// written, by method or route. The only model call that may be given anything of a kit is pinned
// to its one place, and what it is given has no field for an answer. The last test adds a reader
// in each of those ways to a copy of the sources and shows that the lists change.
//
// Everything here reads text, so a name counts wherever it is written, in a comment too.

// Vitest runs from the repository root.
const SRC = resolve(process.cwd(), "src");
const STORE = "src/vault/application-kit.ts";
const VAULT = "src/vault/vault.ts";
const ROUTES = "src/worker/routes.ts";
const MODEL = "src/ai/question-match.ts";

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

/** Any of the three tables in a statement, however it might be written: after a keyword in either case, quoted or joined. */
const TABLE_IN_SQL = /\b(FROM|INTO|UPDATE|TABLE|JOIN|ON)\s+["`[]?(saved_answers|application_kits|kit_questions)\b/i;
/** The columns only these tables have. */
const COLUMNS = /\b(answer_text|label_key|confirmed_revision|typed_answer)\b/;

/** The owner's calls on the Vault. */
const PUBLIC = [
  "listSavedAnswers",
  "addSavedAnswer",
  "editSavedAnswer",
  "deleteSavedAnswer",
  "getKit",
  "saveKitQuestions",
  "chooseKitParts",
  "answerKitQuestion",
  "approveKit",
  "kitArchiveData",
];
const EXPORTS = ["exportSnapshot", "exportAll", "exportJson", "exportArchiveSnapshot", "exportArchiveStream"];
/**
 * Every way to the store from inside the Vault or the Worker: its getter and its class, the owner's
 * calls, the two helpers that read a kit, and the owner's export, which holds every row.
 */
const WAYS = ["this.kits", "ApplicationKitStore", ...PUBLIC, "kitView", "kitProblems", "kitQuestionProblems", "askKitJudge", ...EXPORTS];
/** Where a member of the Vault's class begins: its name, after any modifiers. */
const MEMBER = /^  (?:(?:private|protected|public|static|async|get|set) )*([A-Za-z_]\w*)\(/;
/** Where a route begins: its router, its verb and its path, which may be on the line below. */
const ROUTE = /^(\w+)\.(get|put|post|delete|patch|all|use)\(\s*"([^"]*)"/;
/** The place of a name written above every method or route, where the imports are. */
const ABOVE = "(above the first)";

/**
 * Where a file writes each way to the store: one place for every time the name is written, in
 * order, and no entry for a name it never writes. A place is the nearest heading at or above.
 */
function written(text: string, heading: RegExp, label: (found: RegExpExecArray) => string, ways = WAYS): Record<string, string[]> {
  const headings = [...text.matchAll(new RegExp(heading.source, "gm"))].map((found) => ({ at: found.index, label: label(found) }));
  const places: Record<string, string[]> = {};
  for (const way of ways) {
    const uses = [...text.matchAll(new RegExp(`\\b${way.replace(".", "\\.")}\\b`, "g"))];
    if (uses.length) places[way] = uses.map((use) => headings.findLast((heading) => heading.at <= use.index)?.label ?? ABOVE).sort();
  }
  return places;
}

/** What the store's module gives out: each line of it that exports, as written. The store's own method named `export` gives nothing out. */
const gives = (tree: Tree) => [...tree.get(STORE)!.matchAll(/^[ \t]*export\b(?!\()(?!\(\)).*$/gm)].map((line) => line[0]);
/** A statement that names a module: an import or export from it, an import of it alone, or `import(...)`. */
const SPECIFIER = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;
/** Who takes anything from a module: every statement in a tree whose path leads to it, by file, with its spaces made single. */
function takers(tree: Tree, of = STORE): Record<string, string[]> {
  const module = of.replace(/\.ts$/, "");
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

/** Where a tree reaches for the store: in the Vault by method, and in the Worker by route. */
const reach = (tree: Tree) => ({
  vault: written(tree.get(VAULT)!, MEMBER, (found) => found[1]!),
  worker: written(tree.get(ROUTES)!, ROUTE, (found) => `${found[1]}.${found[2]}("${found[3]}")`),
});

/** Each owner call, where it is defined, and nowhere else in the Vault. */
const definedOnce = Object.fromEntries(PUBLIC.map((name) => [name, [name]]));

describe("what can reach saved answers and application kits", () => {
  it("is named only by its store, the Vault, the routes, the contract, the web client and its two cards", () => {
    expect(sources.size).toBeGreaterThan(100);
    expect(naming("vault/application-kit", "ApplicationKitStore", ...PUBLIC, TABLE_IN_SQL, COLUMNS)).toEqual([
      STORE,
      VAULT,
      "src/web/api.ts",
      "src/web/components/ApplicationKit.tsx",
      "src/web/components/SavedAnswers.tsx",
      ROUTES,
    ]);
    // The store's own names are in the store and the Vault alone; the web app names only its client's calls.
    expect(naming("vault/application-kit", "ApplicationKitStore", TABLE_IN_SQL, COLUMNS)).toEqual([STORE, VAULT]);
    // The table's SQL and its own columns are the store's alone.
    expect(naming(TABLE_IN_SQL)).toEqual([STORE]);
    expect(naming(COLUMNS)).toEqual([STORE]);
    // One place builds the store, and the schema is the only other file that takes anything from it.
    expect(naming("new ApplicationKitStore(")).toEqual([VAULT]);
    expect(naming("SAVED_ANSWER_MIGRATIONS")).toEqual([STORE, "src/vault/schema.ts"]);
    expect(gives(sources)).toEqual(["export const SAVED_ANSWER_MIGRATIONS: readonly string[] = [", "export class ApplicationKitStore {"]);
    expect(takers(sources)).toEqual({
      "src/vault/schema.ts": ['import { SAVED_ANSWER_MIGRATIONS } from "./application-kit"'],
      [VAULT]: ['import { ApplicationKitStore } from "./application-kit"'],
    });
    // The shared rules and types are read by the store, the Vault, the routes, the render of answers.txt and the web app's kit.
    expect(Object.keys(takers(sources, "src/shared/kit.ts")).sort()).toEqual([
      "src/render/kit.ts",
      STORE,
      VAULT,
      "src/web/api.ts",
      "src/web/components/ApplicationKit.tsx",
      "src/web/components/SavedAnswers.tsx",
      "src/web/kit-save.ts",
      ROUTES,
    ]);
    // What loads with every page, what heads every resume, and what a copy holds, have no field for any of it.
    const contract = sources.get("src/shared/api.ts")!;
    for (const name of ["Me", "Profile"]) {
      const start = contract.indexOf(`export interface ${name} {`);
      expect(start, name).toBeGreaterThan(-1);
      expect(contract.slice(start, contract.indexOf("\n}", start)), name).not.toMatch(/saved|kit\b|answer/i);
    }
  });

  it("is reached in the Vault by the owner's calls, the export and the deletion of a job alone", () => {
    const { vault, worker } = reach(sources);
    const store = vault["this.kits"]!;
    // The getter is reached only from the owner's calls, the two helpers, the export and the deletion of a job.
    expect([...new Set(store)].sort()).toEqual(
      ["addSavedAnswer", "answerKitQuestion", "approveKit", "chooseKitParts", "deleteApplication", "deleteSavedAnswer", "editSavedAnswer", "exportSnapshot", "kitArchiveData", "kitProblems", "kitQuestionProblems", "kitView", "listSavedAnswers", "saveKitQuestions", "today"].sort(),
    );
    // Once each from the export and the deletion of a job.
    expect(store.filter((place) => place === "exportSnapshot")).toHaveLength(1);
    expect(store.filter((place) => place === "deleteApplication")).toHaveLength(1);
    expect(vault).toEqual({
      "this.kits": store,
      // Its class: imported, named as the getter's type, and built by the getter. Nothing builds a second store.
      ApplicationKitStore: [ABOVE, "kits", "kits"],
      // Each owner call is written once, where it is defined: the Vault never calls its own. A call
      // from a connected app's method would pass the owner check, because that method holds the owner's `who`.
      ...definedOnce,
      // A kit's view is made for the owner's reads and writes of a kit, and nowhere else.
      kitView: ["answerKitQuestion", "approveKit", "chooseKitParts", "getKit", "kitView", "saveKitQuestions"],
      // Its problems are worked out for the view, for approval and for the download.
      kitProblems: ["approveKit", "kitArchiveData", "kitProblems", "kitView"],
      // Their questions alone are worked out for those problems, and for Today's two counts per job.
      kitQuestionProblems: ["kitProblems", "kitQuestionProblems", "today"],
      // The judge is asked from the save of a kit's questions alone.
      askKitJudge: ["askKitJudge", "saveKitQuestions"],
      exportSnapshot: ["exportAll", "exportArchiveSnapshot", "exportJson", "exportSnapshot"],
      exportAll: ["exportAll"],
      exportJson: ["exportJson"],
      exportArchiveSnapshot: ["exportArchiveSnapshot", "exportArchiveStream"],
      exportArchiveStream: ["exportArchiveStream"],
    });
    // So not in `me`, nor in anything a copy, a connected app or a run is given. Today, which loads
    // with every room, reads it for two counts per job and gives out no question's or answer's words.
    for (const place of Object.values(vault).flat()) expect(place).not.toMatch(/^(me|mcp\w*|createShare|readShare|tailor\w*|startDocument|beginDocument|usableFacts)$/);
    // The Worker asks for each from one route.
    expect(worker).toEqual({
      listSavedAnswers: ['api.get("/saved-answers")'],
      addSavedAnswer: ['api.post("/saved-answers")'],
      editSavedAnswer: ['api.put("/saved-answers/:id")'],
      deleteSavedAnswer: ['api.delete("/saved-answers/:id")'],
      getKit: ['api.get("/applications/:id/kit")'],
      saveKitQuestions: ['api.put("/applications/:id/kit/questions")'],
      chooseKitParts: ['api.put("/applications/:id/kit/parts")'],
      answerKitQuestion: ['api.post("/applications/:id/kit/questions/:qid")'],
      approveKit: ['api.post("/applications/:id/kit/approve")'],
      // Read twice by the download: before and after its files are made.
      kitArchiveData: ['api.get("/applications/:id/kit/archive")', 'api.get("/applications/:id/kit/archive")'],
      exportJson: ['api.get("/export")'],
      exportArchiveStream: ['api.get("/export/archive")'],
    });
    // The questions route alone takes a larger body.
    expect(sources.get(ROUTES)).toContain('api.put("/applications/:id/kit/questions", KIT_JSON_LIMIT,');
    expect(naming("KIT_JSON_LIMIT")).toEqual([ROUTES]);

    // Every owner call checks the owner before anything else.
    const lines = sources.get(VAULT)!.split("\n");
    for (const method of [...PUBLIC, "exportSnapshot"]) {
      const start = lines.findIndex((line) => MEMBER.exec(line)?.[1] === method);
      expect(start, method).toBeGreaterThan(-1);
      const body = lines.slice(start + 1, lines.findIndex((line, index) => index > start && line === "  }"));
      expect(body[0]?.trim(), method).toBe("this.requireOwner(who);");
    }
    // The save of questions checks again after the judge, before its transaction.
    const save = lines.slice(lines.findIndex((line) => MEMBER.exec(line)?.[1] === "saveKitQuestions"));
    const end = save.findIndex((line) => line === "  }");
    const body = save.slice(0, end).join("\n");
    expect(body.indexOf("this.requireOwner(who);\n    return this.ctx.storage.transactionSync(")).toBeGreaterThan(body.indexOf("await this.askKitJudge("));
  });

  it("asks a model only in askKitJudge, through the vault's own reserved run, and gives it no answer's words", () => {
    // The judge's one call is made in one place, on the run it begins.
    const vault = sources.get(VAULT)!;
    expect(written(vault, MEMBER, (found) => found[1]!, ["matchQuestion"])).toEqual({ matchQuestion: ["askKitJudge", "askKitJudge"] });
    const judge = vault.slice(vault.indexOf("  private async askKitJudge("), vault.indexOf("\n  }\n", vault.indexOf("  private async askKitJudge(")));
    expect(judge).toContain('const m = runModels(this.env, this.vaultId, id, "match", "vault");');
    expect(judge).toContain("m.matchQuestion!({ question: item.text, labels: names })");
    expect(naming("matchQuestion")).toEqual(["src/ai/models.ts", VAULT]);
    // The model's module knows nothing of saved answers or kits, and what it is given is a question and labels.
    expect(takers(sources, "src/shared/kit.ts")[MODEL]).toBeUndefined();
    expect(takers(sources)[MODEL]).toBeUndefined();
    const model = sources.get(MODEL)!;
    expect(model).not.toMatch(/shared\/kit|vault\/application-kit/);
    const item = model.slice(model.indexOf("export interface KitMatchItem {"), model.indexOf("\n}", model.indexOf("export interface KitMatchItem {")));
    expect([...item.matchAll(/^\s+(\w+)\??:/gm)].map((field) => field[1])).toEqual(["question", "labels"]);
    // The labels the judge is given come from the store's list for matching, which holds no answer's words.
    expect(judge).toContain("const names = labels.map((label) => label.label);");
  });

  it("is read in the web app by its own two cards, and never by a pipeline, a Workflow, a copy or a connected app", () => {
    // The list is read by its card, and by the kit, which offers each usable one for a question that asks.
    expect(naming(/\bapi\.savedAnswers\b/)).toEqual(["src/web/components/ApplicationKit.tsx", "src/web/components/SavedAnswers.tsx"]);
    for (const call of ["addSavedAnswer", "editSavedAnswer", "deleteSavedAnswer"])
      expect(naming(new RegExp(`\\bapi\\.${call}\\b`)), call).toEqual(["src/web/components/SavedAnswers.tsx"]);
    for (const call of ["kit", "saveKitQuestions", "chooseKitParts", "answerKitQuestion", "approveKit"])
      expect(naming(new RegExp(`\\bapi\\.${call}\\b`)), call).toEqual(["src/web/components/ApplicationKit.tsx"]);
    expect(naming(/\bapi\.kitArchiveUrl\b/)).toEqual(["src/web/components/ApplicationKit.tsx"]);
    expect(naming("/api/saved-answers")).toEqual(["src/shared/api.ts", "src/web/api.ts"]);
    expect(naming('"/saved-answers')).toEqual([ROUTES]);
    // On Jobs › Rules and answers alone, and the kit on a job's Application tab.
    expect(naming(/\bSavedAnswers\b/)).toEqual(["src/web/components/SavedAnswers.tsx", "src/web/pages/jobs/RulesPage.tsx"]);
    expect(naming(/\bApplicationKit\b/)).toEqual(["src/web/components/ApplicationKit.tsx", "src/web/pages/jobs/JobApplication.tsx"]);
    expect(naming("kit-save")).toEqual(["src/web/components/ApplicationKit.tsx"]);
    // Nothing under the pipelines, the Workflows, the copies' store or the connected apps' server names any of it.
    const elsewhere = [...sources.keys()].filter((path) => /^src\/(pipeline|workflows)\//.test(path) || path === "src/vault/shares.ts" || path === "src/worker/mcp.ts");
    expect(elsewhere.length).toBeGreaterThan(10);
    for (const path of elsewhere)
      expect(sources.get(path), path).not.toMatch(/shared\/kit|application-kit|ApplicationKitStore|saved_answers|application_kits|kit_questions|SavedAnswer|KitView|kitView|kitProblems|kitArchiveData|getKit\b|matchQuestion|this\.kits\b/);
  });

  it("Today's kit item holds only a job's ID and names and two counts", () => {
    /** The fields a type or an object literal written in this text names, in order. */
    const fields = (text: string) => [...text.matchAll(/(\w+)\??:/g)].map((field) => field[1]);
    const between = (text: string, start: string, end: string) => {
      const from = text.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      return text.slice(from, text.indexOf(end, from + start.length));
    };
    // The kit item is the job's ID and names, and two counts.
    const contract = sources.get("src/shared/today.ts")!;
    expect(fields(between(contract, '| ({ kind: "kit";', "\n"))).toEqual(["kind", "unanswered", "sensitive"]);
    expect(between(contract, '| ({ kind: "kit";', "\n")).toContain("} & TodayJob)");
    expect(fields(between(contract, "export interface TodayJob {", "\n}"))).toEqual(["applicationId", "title", "company"]);
    // The Vault counts each job's questions and keeps the counts alone; the job's names come from the job.
    const vault = sources.get(VAULT)!;
    const today = between(vault, "  async today(who: Who): Promise<Today> {", "\n  }\n");
    expect(today).toContain("kits.push({ applicationId, unanswered: unanswered.length, sensitive: refused.length });");
    expect(today).toContain("jobNames: this.todayStore.jobNames(");
    const store = sources.get("src/vault/today.ts")!;
    expect(fields(between(store, "export interface KitCount {", "\n}"))).toEqual(["applicationId", "unanswered", "sensitive"]);
    expect(between(store, "const kits: TodayWaiting[] =", "});\n")).toContain(
      'return { kind: "kit", applicationId: kit.applicationId, title: name?.title ?? null, company: name?.company ?? null, unanswered: kit.unanswered, sensitive: kit.sensitive };',
    );
    // Neither the contract nor Today's store knows anything else of a kit.
    for (const path of ["src/shared/today.ts", "src/vault/today.ts"]) {
      expect(takers(sources, "src/shared/kit.ts")[path], path).toBeUndefined();
      expect(sources.get(path), path).not.toMatch(/answer_|savedAnswer|typedAnswer|KitView|kitView|kit_questions|application_kits|saved_answers/);
    }
  });

  it("gains no reader in the Vault or the Worker unseen, whichever way one reaches for the store", () => {
    /** A tree with one text that is there once in a file put in place of another. */
    const replacing = (tree: Tree, path: string, was: string, now: string): Tree => {
      const parts = tree.get(path)!.split(was);
      expect(parts, was).toHaveLength(2);
      return new Map(tree).set(path, parts.join(now));
    };
    /** The sources, or another tree, with one line added directly below a line that is there once. */
    const adding = (path: string, below: string, line: string, tree: Tree = sources): Tree => replacing(tree, path, `${below}\n`, `${below}\n${line}\n`);
    /** What the tests above hold about the Vault and the Worker's routes, read from any tree. */
    const seen = (tree: Tree) => ({ ...reach(tree), sql: namingIn(tree, TABLE_IN_SQL), columns: namingIn(tree, COLUMNS), gives: gives(tree), takers: takers(tree) });
    const asItIs = seen(sources);
    /** The lists as they are, but for one more place under one name. */
    const withPlace = (side: "vault" | "worker", way: string, place: string) => ({
      ...asItIs,
      [side]: { ...asItIs[side], [way]: [...(asItIs[side][way] ?? []), place].sort() },
    });
    const TOOL = "    const jobs = await this.listApplications(who);";
    const PAGE = "  async me(who: Who): Promise<Me> {";
    const PAGE_ROUTE = 'api.get("/me", async (c) => {';

    // Through the store's getter, from a connected app's method or what loads with every page.
    expect(seen(adding(VAULT, TOOL, "    const kept = this.kits.listSaved();"))).toEqual(withPlace("vault", "this.kits", "mcpJobs"));
    expect(seen(adding(VAULT, PAGE, "    const kept = this.kits.listSaved();"))).toEqual(withPlace("vault", "this.kits", "me"));
    // By building the store again, which leaves the getter's count as it was.
    expect(seen(adding(VAULT, PAGE, "    const kept = new ApplicationKitStore(this.sql).listSaved();"))).toEqual(withPlace("vault", "ApplicationKitStore", "me"));
    // By calling the owner's own read, as mcpJobs calls listApplications. The owner check lets it through.
    expect(seen(adding(VAULT, TOOL, "    const kept = await this.listSavedAnswers(who);"))).toEqual(withPlace("vault", "listSavedAnswers", "mcpJobs"));
    expect(seen(adding(VAULT, TOOL, "    const kit = await this.getKit(who, jobs[0]!.id);"))).toEqual(withPlace("vault", "getKit", "mcpJobs"));
    // By the helpers that read a kit, which check no owner of their own.
    expect(seen(adding(VAULT, TOOL, "    const kit = this.kitView(jobs[0]!.id);"))).toEqual(withPlace("vault", "kitView", "mcpJobs"));
    expect(seen(adding(VAULT, TOOL, "    const blocked = this.kitProblems(jobs[0]!.id);"))).toEqual(withPlace("vault", "kitProblems", "mcpJobs"));
    // By asking the judge from somewhere else.
    expect(seen(adding(VAULT, TOOL, '    await this.askKitJudge(jobs[0]!.id, [], []);'))).toEqual(withPlace("vault", "askKitJudge", "mcpJobs"));
    // Out of the owner's export.
    expect(seen(adding(VAULT, TOOL, "    const kept = this.exportSnapshot(who).savedAnswers;"))).toEqual(withPlace("vault", "exportSnapshot", "mcpJobs"));
    // In SQL of its own, in lower case, or by a column only these tables have.
    expect(seen(adding(VAULT, PAGE, "    const kept = this.sql.exec(`select label from saved_answers`).toArray();"))).toEqual({ ...asItIs, sql: [STORE, VAULT] });
    expect(seen(adding(VAULT, PAGE, "    const kept = this.sql.exec(`SELECT answer_text FROM \"saved_answers\"`).toArray();"))).toEqual({ ...asItIs, sql: [STORE, VAULT], columns: [STORE, VAULT] });
    // From the Worker, in the route that loads with every page.
    expect(seen(adding(ROUTES, PAGE_ROUTE, '  const kept = await myVault(c).listSavedAnswers(c.get("who"));'))).toEqual(withPlace("worker", "listSavedAnswers", 'api.get("/me")'));
    expect(seen(adding(ROUTES, PAGE_ROUTE, '  const kit = await myVault(c).kitArchiveData(c.get("who"), "job");'))).toEqual(withPlace("worker", "kitArchiveData", 'api.get("/me")'));

    // Through a helper the store's module gives out beside its class, taken by the Vault or by
    // another of the Vault's modules.
    const HELPER = 'export function peekSaved(sql: SqlStorage) { return sql.exec("SELECT label, answer_text FROM saved_answers").toArray(); }';
    const IMPORT = 'import { ApplicationKitStore } from "./application-kit";';
    const helper = `${sources.get(STORE)!}${HELPER}\n`;
    const given = replacing(new Map(sources).set(STORE, helper), VAULT, IMPORT, 'import { ApplicationKitStore, peekSaved } from "./application-kit";');
    expect(seen(adding(VAULT, TOOL, "    const kept = peekSaved(this.sql);", given))).toEqual({
      ...asItIs,
      gives: [...asItIs.gives, HELPER],
      takers: { ...asItIs.takers, [VAULT]: ['import { ApplicationKitStore, peekSaved } from "./application-kit"'] },
    });
    const taken = adding("src/vault/shares.ts", 'import type { Withheld } from "./sensitive";', 'import { peekSaved } from "./application-kit";', new Map(sources).set(STORE, helper));
    expect(seen(taken)).toEqual({ ...asItIs, gives: [...asItIs.gives, HELPER], takers: { ...asItIs.takers, "src/vault/shares.ts": ['import { peekSaved } from "./application-kit"'] } });
  });
});
