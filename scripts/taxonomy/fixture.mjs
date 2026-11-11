#!/usr/bin/env node
// Builds the small synthetic taxonomy the tests use (test/fixtures/taxonomy) and writes it as a
// TypeScript module, so the same records reach Node tests and the Worker's test runtime.
//
//   node scripts/taxonomy/fixture.mjs           write test/support/taxonomy-fixture.ts
//   node scripts/taxonomy/fixture.mjs --check   fail if that file isn't what the builder gives now

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { combine } from "./combine.mjs";
import { readCrosswalk } from "./crosswalk.mjs";
import { readEsco } from "./esco.mjs";
import { readOnet } from "./onet.mjs";
import { statements } from "./sql.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = join(root, "test", "fixtures", "taxonomy");
export const TARGET = join(root, "test", "support", "taxonomy-fixture.ts");
// Version numbers no release has, so the test taxonomy can never be taken for a real one.
export const FIXTURE_VERSIONS = { esco: "0.0.1", onet: "0.0", crosswalk: "test" };

async function folder(path) {
  const files = {};
  for (const name of (await readdir(path)).sort()) if (name.endsWith(".csv")) files[name] = await readFile(join(path, name), "utf8");
  return files;
}

export async function fixtureBundle() {
  return combine({
    esco: readEsco(await folder(join(FIXTURES, "esco"))),
    onet: readOnet(await folder(join(FIXTURES, "onet"))),
    crosswalk: readCrosswalk(await readFile(join(FIXTURES, "crosswalk.csv"), "utf8"), "crosswalk.csv"),
    versions: FIXTURE_VERSIONS,
  });
}

export async function fixtureModule() {
  const bundle = await fixtureBundle();
  const records = { info: bundle.info, concepts: bundle.concepts, labels: bundle.labels, edges: bundle.edges };
  return [
    "// Written by scripts/taxonomy/fixture.mjs from test/fixtures/taxonomy. Do not edit by hand:",
    "// change the CSV files and run the script. The records are synthetic, not ESCO or O*NET data.",
    'import type { TaxonomyRecords } from "../../src/taxonomy/store";',
    "",
    `export const TAXONOMY_FIXTURE: TaxonomyRecords = ${JSON.stringify(records, null, 2)};`,
    "",
    "/** The SQL that loads the same records into D1, one statement per entry. */",
    `export const TAXONOMY_FIXTURE_SQL: readonly string[] = ${JSON.stringify([...statements(bundle)], null, 2)};`,
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = await fixtureModule();
  if (process.argv.includes("--check")) {
    const current = await readFile(TARGET, "utf8").catch(() => "");
    if (current !== text) {
      console.error("test/support/taxonomy-fixture.ts is out of date. Run: node scripts/taxonomy/fixture.mjs");
      process.exit(1);
    }
  } else await writeFile(TARGET, text);
}
