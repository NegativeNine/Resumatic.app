import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Stage 4 of the redesign rewrote the sentences the Facts room shows a person, so they speak of
// files rather than sources, uploads and extraction. No old sentence may come back in src/.

const root = resolve(__dirname, "../..");

/** The earlier sentences, or the part of each that only it holds. */
const OLD = [
  "this upload expired; start a new upload",
  "no such original source",
  "still reading your other sources",
  "sources during the beta",
  "this source has not been read yet",
  "source has not been converted yet",
  "this source already has a newer run",
  "extraction is already committed for this source",
  "wait for other uploads to finish",
  "this source is no longer being read",
  '"no such source"',
  "That role was rejected. Choose",
  "The import source changed",
];

/**
 * A workflow run started before stage 4 may have stored the old import sentence, so it stays
 * listed as safe to keep for one release, and the web app rewords it.
 */
const KEPT_FOR_RUNS_IN_FLIGHT = "The import source changed. Upload it again.";
const MAY_KEEP = ["src/workflows/steps.ts", "src/web/source-error.ts"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("the Facts room's words", () => {
  it("no old Facts sentence is left in src/", () => {
    const found: string[] = [];
    for (const path of sources(join(root, "src"))) {
      const file = relative(root, path);
      let text = readFileSync(path, "utf8");
      if (MAY_KEEP.includes(file)) text = text.split(KEPT_FOR_RUNS_IN_FLIGHT).join("");
      for (const old of OLD) if (text.includes(old)) found.push(`${file}: ${old}`);
    }
    expect(found).toEqual([]);
  });
});
