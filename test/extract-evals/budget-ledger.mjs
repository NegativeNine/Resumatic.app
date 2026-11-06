import {
  constants,
  closeSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, basename, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { privateRoot } from "./private-dataset.mjs";

const NAME = "first-staging-evals-budget.sqlite";
const CANT_OPEN = "live_eval_ledger_unavailable";
const SUITES = new Set(["extraction", "tailoring"]);

function validatePath(path, exists = true) {
  try {
    if (!isAbsolute(path) || basename(path) !== NAME) throw new Error();
    const root = privateRoot(dirname(path));
    if (path !== join(root, NAME)) throw new Error();
    if (exists) {
      if (realpathSync(path) !== path) throw new Error();
      const st = statSync(path);
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        (st.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && st.uid !== process.getuid())
      )
        throw new Error();
    }
    return path;
  } catch {
    throw new Error(CANT_OPEN);
  }
}
function integer(value) {
  return Number.isSafeInteger(value) && value > 0;
}
/** The fixed filename is a one-shot authorization marker. An existing marker is never reset. */
export function createPilotLedger(directory, budgetMicros, maxCalls) {
  if (
    !integer(budgetMicros) ||
    budgetMicros < 2 ||
    !integer(maxCalls) ||
    maxCalls < 2
  )
    throw new Error("live_eval_budget_invalid");
  const root = privateRoot(directory);
  const file = validatePath(join(root, NAME), false);
  const extractionMicros = Math.floor(budgetMicros / 2),
    extractionCalls = Math.floor(maxCalls / 2);
  try {
    // Exclusive creation means concurrent launches or a later restart cannot reset this campaign.
    const fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
  } catch {
    throw new Error("live_eval_campaign_already_started");
  }
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE meta (version INTEGER NOT NULL, total_micros INTEGER NOT NULL, total_calls INTEGER NOT NULL); CREATE TABLE budgets (suite TEXT PRIMARY KEY, max_micros INTEGER NOT NULL, max_calls INTEGER NOT NULL, used_micros INTEGER NOT NULL DEFAULT 0, used_calls INTEGER NOT NULL DEFAULT 0);",
    );
    db.prepare("INSERT INTO meta VALUES (1,?,?)").run(budgetMicros, maxCalls);
    const insert = db.prepare(
      "INSERT INTO budgets (suite,max_micros,max_calls) VALUES (?,?,?)",
    );
    insert.run("extraction", extractionMicros, extractionCalls);
    insert.run(
      "tailoring",
      budgetMicros - extractionMicros,
      maxCalls - extractionCalls,
    );
    db.exec("COMMIT");
  } catch {
    try {
      db?.exec("ROLLBACK");
    } catch {}
    throw new Error(CANT_OPEN);
  } finally {
    db?.close();
  }
  return {
    file,
    extraction: { micros: extractionMicros, calls: extractionCalls },
    tailoring: {
      micros: budgetMicros - extractionMicros,
      calls: maxCalls - extractionCalls,
    },
  };
}
/** Transaction commits conservative reservation before the provider request leaves the process. */
export function reservePilotLedger(
  file,
  suite,
  configuredMicros,
  configuredCalls,
  costMicros,
  attemptWeight = 1,
) {
  validatePath(file);
  if (
    !SUITES.has(suite) ||
    !integer(configuredMicros) ||
    !integer(configuredCalls) ||
    !integer(costMicros) ||
    !integer(attemptWeight)
  )
    throw new Error(CANT_OPEN);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    const meta = db
      .prepare("SELECT version,total_micros,total_calls FROM meta")
      .get();
    const row = db
      .prepare(
        "SELECT max_micros,max_calls,used_micros,used_calls FROM budgets WHERE suite=?",
      )
      .get(suite);
    const sums = db
      .prepare(
        "SELECT SUM(max_micros) AS max_micros, SUM(max_calls) AS max_calls FROM budgets",
      )
      .get();
    if (
      !meta ||
      meta.version !== 1 ||
      !integer(meta.total_micros) ||
      !integer(meta.total_calls) ||
      !row ||
      !integer(row.max_micros) ||
      !integer(row.max_calls) ||
      !Number.isSafeInteger(row.used_micros) ||
      row.used_micros < 0 ||
      !Number.isSafeInteger(row.used_calls) ||
      row.used_calls < 0 ||
      sums.max_micros !== meta.total_micros ||
      sums.max_calls !== meta.total_calls ||
      configuredMicros !== row.max_micros ||
      configuredCalls !== row.max_calls
    )
      throw new Error(CANT_OPEN);
    if (
      attemptWeight > row.max_calls - row.used_calls ||
      costMicros > row.max_micros - row.used_micros
    )
      throw new Error("live_eval_budget_exhausted");
    db.prepare(
      "UPDATE budgets SET used_micros = used_micros + ?, used_calls = used_calls + ? WHERE suite = ?",
    ).run(costMicros, attemptWeight, suite);
    db.exec("COMMIT");
    return {
      calls: row.used_calls + attemptWeight,
      reservedUsd: (row.used_micros + costMicros) / 1_000_000,
    };
  } catch (error) {
    try {
      db?.exec("ROLLBACK");
    } catch {}
    if (
      error instanceof Error &&
      error.message === "live_eval_budget_exhausted"
    )
      throw error;
    throw new Error(CANT_OPEN);
  } finally {
    db?.close();
  }
}
