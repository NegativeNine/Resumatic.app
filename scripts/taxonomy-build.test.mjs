import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "./taxonomy/build.mjs";
import { CROSSWALK_TOLERANCE, attribution, combine } from "./taxonomy/combine.mjs";
import { readCrosswalk } from "./taxonomy/crosswalk.mjs";
import { parseCsv, readTable } from "./taxonomy/csv.mjs";
import { readEsco, withoutQualifier } from "./taxonomy/esco.mjs";
import { FIXTURES, FIXTURE_VERSIONS, TARGET, fixtureBundle, fixtureModule } from "./taxonomy/fixture.mjs";
import { readOnet, withoutSoftware } from "./taxonomy/onet.mjs";
import { SCHEMA, sqlFiles, statements } from "./taxonomy/sql.mjs";
import { escoId, escoUri, onetElementId, onetOccupationId, onetTaskId, onetToolId, schemeOf, validConceptId } from "../src/taxonomy/ids.mjs";
import { normalizeLabel, wordRuns, words } from "../src/taxonomy/normalize.mjs";

const S = (n) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";
const PM = "onet:occ:99-1002.00";
const BA = "onet:occ:99-1003.00";

async function folder(path) {
  const files = {};
  for (const name of await readdir(path)) if (name.endsWith(".csv")) files[name] = await readFile(join(path, name), "utf8");
  return files;
}
const escoFiles = () => folder(join(FIXTURES, "esco"));
const onetFiles = () => folder(join(FIXTURES, "onet"));
const crosswalkText = () => readFile(join(FIXTURES, "crosswalk.csv"), "utf8");

test("CSV cells keep commas, quotes and line breaks, whatever the line endings", () => {
  assert.deepEqual(parseCsv('a,b\n1,"x, y"\n'), [["a", "b"], ["1", "x, y"]]);
  assert.deepEqual(parseCsv('\ufeffa,b\r\n"one\ntwo","say ""hi"""\r\n'), [["a", "b"], ["one\ntwo", 'say "hi"']]);
  // No final line break, an empty quoted cell, an empty last cell, a quote inside an unquoted cell.
  assert.deepEqual(parseCsv('a,b,c\n"",x,\n5" disk,y,z'), [["a", "b", "c"], ["", "x", ""], ['5" disk', "y", "z"]]);
  assert.deepEqual(parseCsv("a\n\n\nb\n"), [["a"], ["b"]]);
  assert.deepEqual(parseCsv('a\n""\n'), [["a"], [""]]);
  assert.deepEqual(parseCsv(""), []);
  assert.throws(() => parseCsv('a\n"never closed'), /ends inside a quoted cell/);
  assert.throws(() => parseCsv(null), /must be a string/);
});

test("a table is read by column name, and a changed layout says what the file has", () => {
  const { header, records } = readTable(" Code , Title ,Extra\n 1 , One ,x\n2\n", "t.csv", ["code", "title"], ["missing"]);
  assert.deepEqual(header, ["Code", "Title", "Extra"]);
  assert.deepEqual(records, [{ code: "1", title: "One" }, { code: "2", title: "" }]);
  assert.throws(() => readTable("Code,Name\n1,One\n", "t.csv", ["Code", "Title"]), /t\.csv: missing column Title\. It has: Code, Name/);
  assert.throws(() => readTable("", "t.csv", ["Code"]), /t\.csv: the file is empty/);
});

test("labels and text are compared word for word, keeping what makes a tool's name its own", () => {
  const forms = (text) => words(text).map((word) => word.norm);
  assert.deepEqual(forms("C++, C#/.NET and Node.js (ASP.NET); R&D"), ["c++", "c#", ".net", "and", "node.js", "asp.net", "r&d"]);
  // A hyphen or a slash separates words on both sides alike. A sentence's full stop is not part of a word.
  assert.deepEqual(forms("T-SQL, CI/CD. PL/SQL."), ["t", "sql", "ci", "cd", "pl", "sql"]);
  assert.equal(normalizeLabel("  Front-end   development "), "front end development");
  assert.equal(normalizeLabel("R\u00e9sum\u00e9 writing"), "resume writing");
  assert.equal(normalizeLabel("the team\u2019s work"), "the team's work");
  assert.equal(normalizeLabel("Python (computer programming)"), "python computer programming");
  assert.equal(normalizeLabel("\u2026 \u2014 !"), "");
  // Offsets are into the text as given, so a mention can be shown where it was found.
  const text = "Used Kubernetes (K8s) daily.";
  assert.deepEqual(words(text).map((word) => text.slice(word.start, word.end)), ["Used", "Kubernetes", "K8s", "daily"]);
  const dotted = "see .NET and x.NET";
  assert.deepEqual(words(dotted).map((word) => dotted.slice(word.start, word.end)), ["see", ".NET", "and", "x.NET"]);
  assert.deepEqual(wordRuns(words("manage a team"), 2).map((run) => run[2]), ["manage", "manage a", "a", "a team", "team"]);
  assert.deepEqual(wordRuns(words("a b"), 6, 1).map((run) => run[2]), ["a", "b"]);
  assert.deepEqual(words(undefined), []);
});

test("an ID names its source, and an ESCO ID gives its URI back", () => {
  const uri = "http://data.europa.eu/esco/skill/00000000-0000-4000-8000-000000000003";
  assert.equal(escoId(` ${uri} `), S(3));
  assert.equal(escoUri(S(3)), uri);
  for (const [path, id] of [["skill/S1.2.3", "esco:skill:S1.2.3"], ["isced-f/0611", "esco:isced-f:0611"], ["isco/C2512", "esco:isco:C2512"]]) {
    assert.equal(escoId(`http://data.europa.eu/esco/${path}`), id);
    assert.equal(escoUri(id), `http://data.europa.eu/esco/${path}`);
  }
  for (const bad of ["urn:example:1", "http://data.europa.eu/esco/", "http://data.europa.eu/esco/skill/a/b", "http://data.europa.eu/esco/skill/a b", "https://data.europa.eu/esco/skill/x", null, 7])
    assert.equal(escoId(bad), null, String(bad));
  assert.equal(onetOccupationId("15-1252.00"), "onet:occ:15-1252.00");
  for (const bad of ["15-1252", "151252.00", "15-1252.0", " 15-1252.00", null]) assert.equal(onetOccupationId(bad), null, String(bad));
  assert.equal(onetElementId("activity", " 4.A.3.b.1.I01.D01 "), "onet:activity:4.A.3.b.1.I01.D01");
  assert.equal(onetElementId("activity", "4.A/3"), null);
  assert.equal(onetElementId("skill", "4.A"), null);
  assert.equal(onetTaskId(9001), "onet:task:9001");
  assert.equal(onetTaskId("0"), null);
  assert.equal(onetToolId("amazon web services aws software"), "onet:tool:amazon-web-services-aws-software");
  assert.equal(onetToolId("c++"), "onet:tool:c++");
  assert.equal(onetToolId(".net framework"), "onet:tool:net-framework");
  assert.equal(onetToolId("!!!"), null);
  for (const id of [S(3), O(1), DEV, "onet:tool:c++", "onet:tool:c#", "onet:activity:4.A.3.b.1", "esco:isced-f:061"]) assert.equal(validConceptId(id), true, id);
  for (const bad of ["", "skill:1", "esco:skill:", "esco:Skill:x", "other:skill:x", "esco:skill:a b", "esco:skill:x'--", `esco:skill:${"x".repeat(121)}`, null]) assert.equal(validConceptId(bad), false, String(bad));
  assert.equal(schemeOf(DEV), "onet");
  assert.equal(schemeOf("nope"), null);
  assert.equal(escoUri(DEV), null);
});

test("ESCO is read as it is written, with other labels split out and bad rows counted", async () => {
  const esco = readEsco(await escoFiles());
  const byId = new Map(esco.concepts.map((concept) => [concept.id, concept]));
  assert.equal(esco.concepts.length, 16);
  assert.deepEqual(byId.get(S(1)), {
    id: S(1), kind: "skill", scheme: "esco", code: null, label: "manage budgets",
    // A description that ran over two lines is stored on one.
    description: "Plan, monitor and report on the budget. Synthetic test row.", meta: { reuse: "cross-sector" },
  });
  assert.equal(byId.get(S(3)).kind, "knowledge");
  assert.deepEqual(byId.get(S(3)).meta, { reuse: "sector-specific", collections: ["digital"] });
  assert.deepEqual(byId.get(S(2)).meta.collections, ["transversal"]);
  assert.equal(byId.get(S(8)).description, 'The query language "SQL".');
  assert.deepEqual(byId.get(O(1)), {
    id: O(1), kind: "occupation", scheme: "esco", code: "2512.4", label: "software developer",
    description: "Software developers implement or program software systems.", meta: { iscoGroup: "2512" },
  });
  assert.equal(byId.get("esco:skill:S1.1").kind, "skill-group");
  assert.equal(byId.get("esco:isced-f:061").code, "061");
  assert.equal(byId.get("esco:isco:C2512").kind, "occupation-group");

  const labelsOf = (id) => esco.labels.filter((label) => label.conceptId === id).map((label) => `${label.type}:${label.text}`);
  assert.deepEqual(labelsOf(S(1)), ["preferred:manage budgets", "alternative:budget management", "alternative:manage a budget"]);
  // The only label ESCO didn't write is marked as the builder's.
  assert.deepEqual(labelsOf(S(3)), ["preferred:Python (computer programming)", "alternative:Python", "hidden:python3", "derived:Python"]);
  assert.deepEqual(labelsOf(S(6)), ["preferred:Go (computer programming)", "alternative:Golang", "derived:Go"]);
  assert.deepEqual(labelsOf(O(1)), ["preferred:software developer", "alternative:software engineer", "alternative:programmer"]);

  const has = (src, rel, dst) => esco.edges.some((edge) => edge.src === src && edge.rel === rel && edge.dst === dst);
  assert.ok(has(O(1), "essential", S(3)));
  assert.ok(has(O(1), "optional", S(4)));
  assert.ok(has(S(5), "skill-optional", S(8)));
  assert.ok(has(S(1), "broader", "esco:skill:S1.1"));
  assert.ok(has(O(1), "broader", "esco:isco:C2512"));
  // A relation to a concept the package doesn't hold is read here and set aside when everything is joined.
  assert.ok(has(O(3), "optional", S(99)));
  assert.deepEqual(esco.issues, { esco_concept_repeated: 1, esco_relation_type_not_recognised: 1, esco_uri_not_recognised: 1 });
  assert.deepEqual(esco.files.map((file) => [file.name, file.rows]).slice(0, 3), [["skills_en.csv", 10], ["skillGroups_en.csv", 3], ["occupations_en.csv", 3]]);

  assert.equal(withoutQualifier("Python (computer programming)"), "Python");
  assert.equal(withoutQualifier("manage budgets"), null);
  assert.equal(withoutQualifier("(only this)"), null);
  assert.equal(withoutQualifier("C (computer programming)"), null);
});

test("ESCO stops on a missing file or column, and reads a package named without its language", async () => {
  const files = await escoFiles();
  const { ["skills_en.csv"]: skills, ...withoutSkills } = files;
  assert.throws(() => readEsco(withoutSkills), /ESCO package: skills_en\.csv is missing/);
  assert.throws(() => readEsco({ ...files, "skills_en.csv": skills.replace("preferredLabel", "prefLabel") }), /skills_en\.csv: missing column preferredLabel\. It has: conceptType, conceptUri, skillType/);
  assert.equal(readEsco({ ...withoutSkills, "SKILLS.CSV": skills }).concepts.length, 16);
  // Another language's package is asked for by its code.
  assert.throws(() => readEsco(files, { language: "fr" }), /skills_fr\.csv is missing/);
  // The optional files can be absent.
  const { ["skillGroups_en.csv"]: _groups, ["digitalSkillsCollection_en.csv"]: _digital, ...fewer } = files;
  const read = readEsco(fewer);
  assert.equal(read.concepts.some((concept) => concept.kind === "skill-group"), false);
  assert.equal(read.concepts.find((concept) => concept.id === S(3)).meta.collections, undefined);
});

test("O*NET is read as it is written: occupations, titles, activities, tasks and software", async () => {
  const onet = readOnet(await onetFiles());
  const byId = new Map(onet.concepts.map((concept) => [concept.id, concept]));
  const kinds = {};
  for (const concept of onet.concepts) kinds[concept.kind] = (kinds[concept.kind] ?? 0) + 1;
  assert.deepEqual(kinds, { occupation: 3, activity: 10, task: 5, tool: 6, "tool-category": 3 });
  assert.deepEqual(byId.get(DEV), {
    id: DEV, kind: "occupation", scheme: "onet", code: "99-1001.00", label: "Example Software Developers",
    description: "Research, design, and develop computer software. Synthetic test row.", meta: {},
  });
  const labelsOf = (id) => onet.labels.filter((label) => label.conceptId === id).map((label) => `${label.type}:${label.text}`);
  assert.deepEqual(labelsOf(PM), ["preferred:Example Project Management Specialists", "alternative:Technical Project Manager", "alternative:Tech PM"]);

  // Three levels of work activity, each named once, each under the one above.
  assert.deepEqual(byId.get("onet:activity:4.A.3.b.1").meta, { level: "general" });
  assert.deepEqual(byId.get("onet:activity:4.A.3.b.1.I01").meta, { level: "intermediate" });
  assert.equal(byId.get("onet:activity:4.A.3.b.1.I01.D02").label, "Migrate software systems to new platforms.");
  const edges = (rel) => onet.edges.filter((edge) => edge.rel === rel).map((edge) => [edge.src, edge.dst, edge.meta]);
  assert.equal(edges("broader").filter(([src]) => src.startsWith("onet:activity:")).length, 7);

  // A task belongs to its occupation, is not a label, and reaches activities; the occupation
  // reaches each activity once, counting the tasks that carry it out.
  assert.deepEqual(byId.get("onet:task:9002"), { id: "onet:task:9002", kind: "task", scheme: "onet", code: "9002", label: "Move services from one hosting platform to another.", description: null, meta: { taskType: "Supplemental" } });
  assert.deepEqual(byId.get("onet:task:9005").meta, {});
  assert.deepEqual(labelsOf("onet:task:9002"), []);
  assert.deepEqual(edges("task-of").find(([src]) => src === "onet:task:9005"), ["onet:task:9005", PM, null]);
  assert.deepEqual(edges("performs").sort(), [
    [BA, "onet:activity:4.A.4.c.3.I01.D01", { tasks: 1 }],
    [DEV, "onet:activity:4.A.3.b.1.I01.D01", { tasks: 2 }],
    [DEV, "onet:activity:4.A.3.b.1.I01.D02", { tasks: 1 }],
    [PM, "onet:activity:4.A.4.b.4.I01.D01", { tasks: 1 }],
    [PM, "onet:activity:4.A.4.c.3.I01.D01", { tasks: 1 }],
  ].sort());

  // Software has no ID of its own. Names that compare equal are one tool.
  assert.deepEqual(byId.get("onet:tool:python"), { id: "onet:tool:python", kind: "tool", scheme: "onet", code: null, label: "Python", description: null, meta: { hot: true } });
  assert.deepEqual(labelsOf("onet:tool:python"), ["preferred:Python", "alternative:python"]);
  assert.deepEqual(labelsOf("onet:tool:amazon-web-services-aws-software"), ["preferred:Amazon Web Services AWS software", "derived:Amazon Web Services AWS"]);
  assert.deepEqual(byId.get("onet:tool:go").meta, {});
  assert.deepEqual(byId.get("onet:toolcat:5.A.2.01").label, "Spreadsheet software");
  assert.deepEqual(edges("uses").filter(([, dst]) => dst === "onet:tool:microsoft-excel").sort(), [
    [BA, "onet:tool:microsoft-excel", { inDemand: true, hot: true }],
    [PM, "onet:tool:microsoft-excel", { inDemand: false, hot: false }],
  ].sort());
  assert.equal(edges("broader").filter(([src, dst]) => src === "onet:tool:python" && dst === "onet:toolcat:5.A.1.01").length, 1);

  assert.deepEqual(onet.issues, { onet_software_not_recognised: 1, onet_task_activity_not_recognised: 1, onet_title_for_unknown_occupation: 1 });
  assert.equal(withoutSoftware("Amazon Web Services AWS software"), "Amazon Web Services AWS");
  assert.equal(withoutSoftware("Software"), null);
  assert.equal(withoutSoftware("R software"), null);
  assert.equal(withoutSoftware("Python"), null);
});

test("O*NET stops on an earlier release's layout, and says which release it reads", async () => {
  const files = await onetFiles();
  const { ["occupation_data.csv"]: occupations, ...rest } = files;
  assert.throws(() => readOnet({ ...rest, "Occupation Data.txt": occupations }), /occupation_data\.csv is missing\. This builder reads the 30\.3 and later CSV release/);
  assert.throws(() => readOnet({ ...files, "software_skills.csv": files["software_skills.csv"].replace("Workplace Example", "Example") }), /software_skills\.csv: missing column Workplace Example\. It has: O\*NET-SOC Code, Title, Example/);
  // Job titles and task statements are optional: tasks are then known only where they reach an activity.
  const { ["job_titles.csv"]: _titles, ["task_statements.csv"]: _tasks, ...fewer } = files;
  const read = readOnet(fewer);
  assert.equal(read.concepts.filter((concept) => concept.kind === "task").length, 5);
  assert.equal(read.labels.some((label) => label.type === "alternative" && label.kind === "occupation"), false);
});

test("the crosswalk skips the official metadata preamble before finding its columns", async () => {
  const csv = await crosswalkText();
  const preamble = [
    "\ufeffMapping project name,ESCO-O*NET Crosswalk,,,,,",
    "Mapping project version,1,,,,,",
    "Classification 1 Version,O*NET-SOC 2019,,,,,",
    "Classification 2 Version,v1.1.0,,,,,",
    ",,,,,,",
    ",,,,,,",
  ].join("\r\n");
  assert.deepEqual(readCrosswalk(`${preamble}\r\n${csv}`), readCrosswalk(csv));
  assert.throws(() => readCrosswalk(`${preamble}\r\nCode,Uri\r\n1,2\r\n`), /no column found/);
});

test("the crosswalk is found by what its columns are called", async () => {
  const read = readCrosswalk(await crosswalkText(), "crosswalk.csv");
  assert.deepEqual(read.columns, { onet: "O*NET Id", esco: "ESCO or ISCO URI", type: "Type of Match" });
  assert.deepEqual(read.edges, [
    { src: DEV, rel: "matches", dst: O(1), meta: { type: "exact" } },
    { src: PM, rel: "matches", dst: O(2), meta: { type: "close" } },
    { src: BA, rel: "matches", dst: O(3), meta: { type: "broad" } },
    { src: DEV, rel: "matches", dst: "esco:isco:C2512", meta: { type: "narrow" } },
  ]);
  assert.deepEqual(read.issues, {});
  const uri = (n) => `http://data.europa.eu/esco/occupation/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const other = readCrosswalk(
    [
      "ESCO URI,Match type,O*NET-SOC Code",
      `${uri(1)},related,99-1001.00`,
      `${uri(1)},exact,99-1001.00`,
      `${uri(2)},sideways,99-1002.00`,
      `urn:x,exact,99-1002.00`,
      `${uri(3)},exact,1002`,
    ].join("\n"),
  );
  assert.deepEqual(other.edges, [{ src: DEV, rel: "matches", dst: O(1), meta: { type: "related" } }]);
  assert.deepEqual(other.issues, { crosswalk_esco_uri_not_recognised: 1, crosswalk_match_type_not_recognised: 1, crosswalk_onet_code_not_recognised: 1, crosswalk_pair_repeated: 1 });
  assert.throws(() => readCrosswalk("Code,Uri\n1,2\n", "x.csv"), /x\.csv: no column found for onet, type\. It has: Code, Uri/);
  assert.throws(() => readCrosswalk("", "x.csv"), /x\.csv: the file is empty/);
});

test("the sources are joined into one set, in a fixed order, with nothing inferred but what is marked", async () => {
  const bundle = await fixtureBundle();
  assert.match(bundle.info.version, /^esco-0\.0\.1\+onet-0\.0\+[0-9a-f]{8}$/);
  assert.equal(bundle.info.version.endsWith(bundle.info.contentHash.slice(0, 8)), true);
  assert.equal(bundle.info.format, 1);
  assert.deepEqual(bundle.counts.conceptsBySource, { esco: 16, onet: 27 });
  assert.deepEqual(bundle.counts.concepts, { activity: 10, knowledge: 4, occupation: 6, "occupation-group": 2, skill: 4, "skill-group": 3, task: 5, tool: 6, "tool-category": 3 });
  assert.deepEqual(bundle.counts.relations, { broader: 19, essential: 4, matches: 4, optional: 3, performs: 5, "same-label": 3, "skill-optional": 1, "task-activity": 6, "task-of": 5, uses: 8 });
  assert.deepEqual(bundle.problems, {
    esco_concept_repeated: 1, esco_relation_type_not_recognised: 1, esco_uri_not_recognised: 1,
    onet_software_not_recognised: 1, onet_task_activity_not_recognised: 1, onet_title_for_unknown_occupation: 1,
    relation_repeated: 1, relation_to_unknown_concept: 1,
  });

  // Records are in order, and every relation's ends exist.
  const ids = bundle.concepts.map((concept) => concept.id);
  assert.deepEqual(ids, [...ids].sort());
  const known = new Set(ids);
  for (const edge of bundle.edges) assert.ok(known.has(edge.src) && known.has(edge.dst), `${edge.src} ${edge.rel} ${edge.dst}`);
  for (const label of bundle.labels) {
    assert.ok(known.has(label.conceptId));
    assert.equal(label.norm, normalizeLabel(label.text));
  }
  // One label per concept and comparison form: the source's own wording wins over a derived one.
  const python = bundle.labels.filter((label) => label.conceptId === S(3)).map((label) => `${label.type}:${label.norm}`);
  assert.deepEqual(python.sort(), ["alternative:python", "hidden:python3", "preferred:python computer programming"]);
  assert.deepEqual(bundle.labels.filter((label) => label.conceptId === "onet:tool:python").map((label) => label.type), ["preferred"]);
  assert.equal(bundle.labels.some((label) => label.kind === "task"), false);

  // The only links between the two sources: the official crosswalk, and labels that compare equal.
  const across = bundle.edges.filter((edge) => schemeOf(edge.src) !== schemeOf(edge.dst));
  assert.deepEqual([...new Set(across.map((edge) => edge.rel))].sort(), ["matches", "same-label"]);
  assert.deepEqual(across.filter((edge) => edge.rel === "same-label").map((edge) => [edge.src, edge.dst]), [
    ["onet:tool:go", S(6)],
    ["onet:tool:kubernetes", S(4)],
    ["onet:tool:python", S(3)],
  ]);
});

test("the same files always give the same taxonomy, whatever order they are read in", async () => {
  const first = await fixtureBundle();
  const esco = readEsco(await escoFiles());
  const onet = readOnet(await onetFiles());
  const crosswalk = readCrosswalk(await crosswalkText());
  const shuffled = await combine({
    esco: { ...esco, concepts: [...esco.concepts].reverse(), labels: [...esco.labels].reverse(), edges: [...esco.edges].reverse() },
    onet: { ...onet, concepts: [...onet.concepts].reverse(), labels: [...onet.labels].reverse(), edges: [...onet.edges].reverse() },
    crosswalk: { ...crosswalk, edges: [...crosswalk.edges].reverse() },
    versions: FIXTURE_VERSIONS,
  });
  assert.equal(shuffled.info.contentHash, first.info.contentHash);
  assert.deepEqual(shuffled.text, first.text);
  // A changed label is a changed taxonomy.
  const changed = await combine({
    esco: { ...esco, concepts: esco.concepts.map((concept) => (concept.id === S(1) ? { ...concept, label: "manage a budget" } : concept)) },
    onet, crosswalk, versions: FIXTURE_VERSIONS,
  });
  assert.notEqual(changed.info.contentHash, first.info.contentHash);
});

test("joining stops when the files don't belong together", async () => {
  const esco = readEsco(await escoFiles());
  const onet = readOnet(await onetFiles());
  const crosswalk = readCrosswalk(await crosswalkText());
  for (const versions of [{ esco: "1.2.1" }, { esco: "latest", onet: "31.0" }, { esco: "1.2.1", onet: "31" }, undefined])
    await assert.rejects(combine({ esco, onet, crosswalk, versions }), /give the (esco|onet) release as a version number/);

  // A few crosswalk rows may name an occupation a newer release has dropped. Most may not.
  const ghost = (n) => ({ src: `onet:occ:98-${String(n).padStart(4, "0")}.00`, rel: "matches", dst: O(1), meta: { type: "exact" } });
  // A crosswalk long enough for two stray rows to be a small share of it.
  const padded = { ...crosswalk, edges: [...crosswalk.edges, ...Array.from({ length: 36 }, () => crosswalk.edges[0])] };
  assert.ok(CROSSWALK_TOLERANCE >= 0.05 && CROSSWALK_TOLERANCE <= 0.2);
  const tolerated = await combine({ esco, onet, crosswalk: { ...padded, edges: [...padded.edges, ghost(1), ghost(2)] }, versions: FIXTURE_VERSIONS });
  assert.equal(tolerated.problems.crosswalk_occupation_not_in_release, 2);
  await assert.rejects(
    combine({ esco, onet, crosswalk: { ...crosswalk, edges: [...crosswalk.edges, ghost(1), ghost(2)] }, versions: FIXTURE_VERSIONS }),
    /2 of 6 crosswalk rows name an occupation that isn't in these releases/,
  );
  // The crosswalk relates occupations, and nothing else.
  const toSkill = await combine({ esco, onet, crosswalk: { ...padded, edges: [...padded.edges, { src: DEV, rel: "matches", dst: S(1), meta: { type: "exact" } }] }, versions: FIXTURE_VERSIONS });
  assert.equal(toSkill.problems.crosswalk_occupation_not_in_release, 1);
  assert.equal(toSkill.edges.some((edge) => edge.rel === "matches" && edge.dst === S(1)), false);

  await assert.rejects(combine({ esco: { ...esco, concepts: [...esco.concepts, { ...esco.concepts[0], id: "nope" }] }, onet, crosswalk, versions: FIXTURE_VERSIONS }), /no place for/);
  await assert.rejects(combine({ esco, onet: { ...onet, concepts: [...onet.concepts, esco.concepts[0]] }, crosswalk, versions: FIXTURE_VERSIONS }), /two sources produced the same concept/);
  await assert.rejects(combine({ esco: { ...esco, edges: [{ src: S(1), rel: "invented", dst: S(2), meta: null }] }, onet, crosswalk, versions: FIXTURE_VERSIONS }), /unknown relation: invented/);
});

test("a label shared by several concepts links none of them", async () => {
  const esco = readEsco(await escoFiles());
  const onet = readOnet(await onetFiles());
  const crosswalk = readCrosswalk(await crosswalkText());
  // A second ESCO concept also called Python: the tool can no longer be said to be either.
  const twin = { id: S(50), kind: "knowledge", scheme: "esco", code: null, label: "Python", description: null, meta: {} };
  const bundle = await combine({
    esco: { ...esco, concepts: [...esco.concepts, twin], labels: [...esco.labels, { conceptId: S(50), kind: "knowledge", type: "preferred", text: "Python" }] },
    onet, crosswalk, versions: FIXTURE_VERSIONS,
  });
  assert.equal(bundle.edges.some((edge) => edge.rel === "same-label" && edge.src === "onet:tool:python"), false);
  assert.equal(bundle.problems.same_label_ambiguous, 1);
  // A hidden term is too loose to link on.
  const hiddenOnly = await combine({
    esco: { ...esco, labels: esco.labels.map((label) => (label.conceptId === S(4) && label.text === "Kubernetes" ? { ...label, type: "hidden" } : label)) },
    onet, crosswalk, versions: FIXTURE_VERSIONS,
  });
  assert.equal(hiddenOnly.edges.some((edge) => edge.rel === "same-label" && edge.src === "onet:tool:kubernetes"), false);
});

test("the SQL loads into SQLite as written, one statement to a line, and holds every record", async () => {
  const bundle = await fixtureBundle();
  const all = [...statements(bundle)];
  assert.deepEqual(all.slice(0, SCHEMA.length), SCHEMA.map((statement) => `${statement};`));
  for (const statement of all) {
    assert.equal(/[\r\n]/.test(statement), false);
    assert.ok(statement.endsWith(";"));
  }
  // Statements stay under the size asked for, apart from a single row that is larger by itself.
  const small = [...statements(bundle, { maxBytes: 600 })];
  assert.ok(small.length > all.length);
  for (const statement of small) assert.ok(Buffer.byteLength(statement) <= 600 || !statement.includes("), ("), statement.slice(0, 80));
  const files = sqlFiles(bundle, { maxBytes: 600, maxFileBytes: 4000 });
  assert.ok(files.length > 3);
  for (const file of files) assert.ok(Buffer.byteLength(file) <= 4000 && file.endsWith(";\n"));
  assert.deepEqual(files.join("").trimEnd().split("\n"), small);

  const db = new DatabaseSync(":memory:");
  try {
    for (const file of files) db.exec(file);
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.equal(count("concepts"), bundle.concepts.length);
    assert.equal(count("labels"), bundle.labels.length);
    assert.equal(count("relations"), bundle.edges.length);
    assert.deepEqual(Object.fromEntries(db.prepare(`SELECT key, value FROM taxonomy_meta`).all().map((row) => [row.key, row.value])), {
      format: "1", version: bundle.info.version, contentHash: bundle.info.contentHash, sources: JSON.stringify(bundle.info.sources),
    });
    // Apostrophes and quotes come back as they went in.
    assert.equal(db.prepare(`SELECT description FROM concepts WHERE id = ?`).get(S(4)).description, "Tools that deploy, scale and run containers. It's a synthetic row, with a comma.");
    assert.equal(db.prepare(`SELECT description FROM concepts WHERE id = ?`).get(S(8)).description, 'The query language "SQL".');
    assert.deepEqual(JSON.parse(db.prepare(`SELECT meta FROM relations WHERE src = ? AND rel = 'performs' AND dst = ?`).get(DEV, "onet:activity:4.A.3.b.1.I01.D01").meta), { tasks: 2 });
    assert.equal(db.prepare(`SELECT meta FROM relations WHERE rel = 'broader' LIMIT 1`).get().meta, null);
    // The lookups the Worker makes use the indexes.
    const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail).join(" | ");
    assert.match(plan(`SELECT * FROM labels WHERE norm IN (?, ?)`, "a", "b"), /SEARCH labels USING PRIMARY KEY/);
    assert.match(plan(`SELECT * FROM relations WHERE src = ? AND rel IN (?)`, "a", "b"), /SEARCH relations USING PRIMARY KEY/);
    assert.match(plan(`SELECT * FROM relations WHERE dst = ? AND rel IN (?)`, "a", "b"), /relations_by_dst/);
    assert.match(plan(`SELECT * FROM concepts WHERE id IN (?, ?)`, "a", "b"), /SEARCH concepts USING PRIMARY KEY/);
  } finally { db.close(); }

  const withBreak = { ...bundle, concepts: [{ ...bundle.concepts[0], label: "two\nlines" }] };
  assert.throws(() => [...statements(withBreak)], /line break/);
});

test("the build writes records, SQL and a manifest that says what went in and what to credit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taxonomy-build-"));
  try {
    const out = join(dir, "out");
    await writeFile(join(dir, "stale.txt"), "kept: outside the output folder");
    const manifest = await build({
      esco: join(FIXTURES, "esco"), onet: join(FIXTURES, "onet"), crosswalk: join(FIXTURES, "crosswalk.csv"),
      out, escoVersion: "1.2.1", onetVersion: "31.0", crosswalkVersion: "2023-08",
    });
    assert.deepEqual((await readdir(out)).sort(), ["concepts.ndjson", "d1", "labels.ndjson", "manifest.json", "relations.ndjson"]);
    assert.deepEqual(await readdir(join(out, "d1")), ["0001.sql"]);
    const written = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    assert.deepEqual(written, manifest);
    assert.match(manifest.version, /^esco-1\.2\.1\+onet-31\.0\+[0-9a-f]{8}$/);
    assert.equal(manifest.d1Files, 1);
    assert.equal(manifest.language, "en");
    assert.deepEqual(manifest.sources.map((source) => source.version), ["1.2.1", "31.0", "2023-08"]);
    for (const file of [...manifest.inputs.esco, ...manifest.inputs.onet, ...manifest.inputs.crosswalk]) assert.match(file.sha256, /^[0-9a-f]{64}$/, file.name);
    assert.equal(manifest.inputs.onet.find((file) => file.name === "software_skills.csv").rows, 9);
    assert.equal(manifest.setAside.relation_to_unknown_concept, 1);
    // Both sources' own wording, with the O*NET release named, and every change the builder makes.
    assert.equal(manifest.notices[0], "This service uses the ESCO classification of the European Commission.");
    assert.match(manifest.notices[1], /^This service includes information from the O\*NET 31\.0 Database by the U\.S\. Department of Labor, Employment and Training Administration \(USDOL\/ETA\)\. Used under the CC BY 4\.0 license\. O\*NET\u00ae is a trademark of USDOL\/ETA\. Resumatic has modified all or some of this information\. USDOL\/ETA has not approved, endorsed, or tested these modifications\.$/);
    assert.ok(manifest.modifications.length >= 6);
    assert.deepEqual(attribution({ onet: "31.0" }).notices, manifest.notices);

    const lines = (await readFile(join(out, "concepts.ndjson"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 43);
    assert.deepEqual(Object.keys(lines[0]), ["id", "kind", "scheme", "code", "label", "description", "meta"]);
    // Building again replaces the folder and gives the same bytes.
    await writeFile(join(out, "left-over.txt"), "from an earlier build");
    const again = await build({ esco: join(FIXTURES, "esco"), onet: join(FIXTURES, "onet"), crosswalk: join(FIXTURES, "crosswalk.csv"), out, escoVersion: "1.2.1", onetVersion: "31.0", crosswalkVersion: "2023-08" });
    assert.equal(again.contentHash, manifest.contentHash);
    assert.equal((await readdir(out)).includes("left-over.txt"), false);
    assert.equal(await readFile(join(dir, "stale.txt"), "utf8"), "kept: outside the output folder");

    // Only CSV files directly in a folder are read, and the bytes must be text.
    const esco = join(dir, "esco");
    await cp(join(FIXTURES, "esco"), esco, { recursive: true });
    await writeFile(join(esco, "skills_en.csv"), Buffer.from([0xff, 0xfe, 0x00]));
    await assert.rejects(build({ esco, onet: join(FIXTURES, "onet"), crosswalk: join(FIXTURES, "crosswalk.csv"), out, escoVersion: "1.2.1", onetVersion: "31.0" }));
    await assert.rejects(build({ esco: dir, onet: join(FIXTURES, "onet"), crosswalk: join(FIXTURES, "crosswalk.csv"), out, escoVersion: "1.2.1", onetVersion: "31.0" }), /no CSV files in/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the command says what it needs, and fails with the reason", () => {
  const script = fileURLToPath(new URL("./taxonomy/build.mjs", import.meta.url));
  const missing = spawnSync(process.execPath, [script, "--esco", "x"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /missing: --onet --crosswalk --out --esco-version --onet-version/);
  const failed = spawnSync(process.execPath, [script, "--esco", join(FIXTURES, "onet"), "--onet", join(FIXTURES, "onet"), "--crosswalk", join(FIXTURES, "crosswalk.csv"), "--out", join(tmpdir(), "taxonomy-never-written"), "--esco-version", "1.2.1", "--onet-version", "31.0"], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /taxonomy build failed: ESCO package: skills_en\.csv is missing/);
});

test("the test taxonomy in the repository is what the builder gives now", async () => {
  assert.equal(await readFile(TARGET, "utf8"), await fixtureModule(), "run: node scripts/taxonomy/fixture.mjs");
});
