#!/usr/bin/env node
// Builds the combined taxonomy from the official downloads.
//
//   node scripts/taxonomy/build.mjs \
//     --esco <folder of the ESCO classification CSV package> --esco-version 1.2.1 \
//     --onet <folder of the O*NET CSV release>               --onet-version 31.0 \
//     --crosswalk <the O*NET - ESCO occupations crosswalk CSV> \
//     --out <folder to write>
//
// It writes the records (concepts, labels, relations as one JSON object per line), the SQL that
// loads them into D1, and a manifest: which files went in, by SHA-256, what came out, what was set
// aside and why, and the credits a product using the taxonomy must show. It reads CSV text and
// nothing else from the folders it is given. docs/taxonomy.md has the whole procedure.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { attribution, combine } from "./combine.mjs";
import { readCrosswalk } from "./crosswalk.mjs";
import { readEsco } from "./esco.mjs";
import { readOnet } from "./onet.mjs";
import { sqlFiles } from "./sql.mjs";

const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** The CSV files directly inside a folder, as text, with the SHA-256 of each file's bytes. */
async function csvFolder(folder) {
  const files = {};
  const hashes = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.csv$/i.test(entry.name)) continue;
    const bytes = await readFile(join(folder, entry.name));
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${entry.name} is larger than any file these sources publish`);
    files[entry.name] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    hashes[entry.name] = createHash("sha256").update(bytes).digest("hex");
  }
  if (Object.keys(files).length === 0) throw new Error(`no CSV files in ${folder}`);
  return { files, hashes };
}

export async function build({ esco, onet, crosswalk, out, escoVersion, onetVersion, crosswalkVersion, language = "en" }) {
  const escoFolder = await csvFolder(esco);
  const onetFolder = await csvFolder(onet);
  const crosswalkBytes = await readFile(crosswalk);
  const crosswalkName = basename(crosswalk);
  const bundle = await combine({
    esco: readEsco(escoFolder.files, { language }),
    onet: readOnet(onetFolder.files),
    crosswalk: readCrosswalk(new TextDecoder("utf-8", { fatal: true }).decode(crosswalkBytes), crosswalkName),
    versions: { esco: escoVersion, onet: onetVersion, crosswalk: crosswalkVersion },
  });

  const withHash = (list, hashes) => list.map((file) => ({ ...file, sha256: hashes[file.name] }));
  const manifest = {
    ...bundle.info,
    language,
    counts: bundle.counts,
    setAside: bundle.problems,
    inputs: {
      esco: withHash(bundle.files.esco, escoFolder.hashes),
      onet: withHash(bundle.files.onet, onetFolder.hashes),
      crosswalk: withHash(bundle.files.crosswalk, { [crosswalkName]: createHash("sha256").update(crosswalkBytes).digest("hex") }),
    },
    ...attribution({ esco: escoVersion, onet: onetVersion }),
  };

  const target = resolve(out);
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, "d1"), { recursive: true });
  await writeFile(join(target, "concepts.ndjson"), bundle.text.concepts);
  await writeFile(join(target, "labels.ndjson"), bundle.text.labels);
  await writeFile(join(target, "relations.ndjson"), bundle.text.relations);
  const sql = sqlFiles(bundle);
  for (const [at, text] of sql.entries()) await writeFile(join(target, "d1", `${String(at + 1).padStart(4, "0")}.sql`), text);
  manifest.d1Files = sql.length;
  await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      esco: { type: "string" },
      onet: { type: "string" },
      crosswalk: { type: "string" },
      out: { type: "string" },
      "esco-version": { type: "string" },
      "onet-version": { type: "string" },
      "crosswalk-version": { type: "string" },
      language: { type: "string", default: "en" },
    },
  });
  const missing = ["esco", "onet", "crosswalk", "out", "esco-version", "onet-version"].filter((name) => !values[name]);
  if (missing.length) {
    console.error(`missing: ${missing.map((name) => `--${name}`).join(" ")}`);
    process.exit(2);
  }
  try {
    const manifest = await build({
      esco: values.esco,
      onet: values.onet,
      crosswalk: values.crosswalk,
      out: values.out,
      escoVersion: values["esco-version"],
      onetVersion: values["onet-version"],
      crosswalkVersion: values["crosswalk-version"],
      language: values.language,
    });
    console.log(JSON.stringify({ version: manifest.version, counts: manifest.counts, setAside: manifest.setAside, d1Files: manifest.d1Files }, null, 2));
  } catch (error) {
    console.error(`taxonomy build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
