import { SEED_KINDS, type SeedKind } from "./seeded";

export interface SeedRecord {
  caseId: string;
  repeat: number;
  seed?: SeedKind;
  outcome: string;
  caught?: boolean;
  uncertain?: boolean;
  [key: string]: unknown;
}

/** Stop on failure without pretending the remaining cases were evaluated. */
export function seedFailureRecords(caseId: string, repeat: number, activeSeed: SeedKind | undefined, recorded: boolean): SeedRecord[] {
  const records: SeedRecord[] = [];
  if (!recorded) records.push({ caseId, repeat, seed: activeSeed, outcome: "failed" });
  const after = activeSeed === undefined ? 0 : SEED_KINDS.indexOf(activeSeed) + 1;
  for (const seed of SEED_KINDS.slice(after)) records.push({ caseId, repeat, seed, outcome: "not_run" });
  return records;
}

/** A rate is meaningful only when this seed has no failures or unvisited cases. */
export function summarizeSeedRecords(records: SeedRecord[]) {
  return SEED_KINDS.map((kind) => {
    const entries = records.filter((record) => record.seed === kind);
    const planted = entries.filter((record) => record.outcome === "evaluated");
    const caught = planted.filter((record) => record.caught === true && record.uncertain !== true).length;
    const failed = entries.filter((record) => record.outcome === "failed").length;
    const notRun = entries.filter((record) => record.outcome === "not_run").length;
    return {
      kind,
      planted: planted.length,
      caught,
      uncertain: planted.filter((record) => record.uncertain === true).length,
      catchRate: planted.length && !failed && !notRun ? caught / planted.length : null,
      skipped: entries.filter((record) => record.outcome === "inapplicable").length,
      failed,
      notRun,
    };
  });
}
