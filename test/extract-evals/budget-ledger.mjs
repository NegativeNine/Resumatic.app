import {
  constants,
  closeSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, basename, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
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
export function createPilotLedger(directory, budgetMicros, maxCalls, extractionCallLimit = Math.floor(maxCalls / 2)) {
  if (
    !integer(budgetMicros) ||
    budgetMicros < 2 ||
    !integer(maxCalls) ||
    maxCalls < 2 ||
    !integer(extractionCallLimit) ||
    extractionCallLimit >= maxCalls
  )
    throw new Error("live_eval_budget_invalid");
  const root = privateRoot(directory);
  const file = validatePath(join(root, NAME), false);
  const extractionMicros = Math.floor(budgetMicros / 2),
    extractionCalls = extractionCallLimit;
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
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE meta (version INTEGER NOT NULL, total_micros INTEGER NOT NULL, total_calls INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 0); CREATE TABLE budgets (suite TEXT PRIMARY KEY, max_micros INTEGER NOT NULL, max_calls INTEGER NOT NULL, used_micros INTEGER NOT NULL DEFAULT 0, used_calls INTEGER NOT NULL DEFAULT 0); CREATE TABLE attempts (id TEXT PRIMARY KEY, suite TEXT NOT NULL, reserved_micros INTEGER NOT NULL, actual_micros INTEGER, state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown')));",
    );
    db.prepare(
      "INSERT INTO meta (version,total_micros,total_calls) VALUES (2,?,?)",
    ).run(budgetMicros, maxCalls);
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
  attemptId = randomUUID(),
) {
  validatePath(file);
  if (
    !SUITES.has(suite) ||
    !integer(configuredMicros) ||
    !integer(configuredCalls) ||
    !integer(costMicros) ||
    !integer(attemptWeight) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(attemptId)
  )
    throw new Error(CANT_OPEN);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
    );
    const meta = db
      .prepare("SELECT version,total_micros,total_calls,frozen FROM meta")
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
      meta.version !== 2 ||
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
    if (meta.frozen !== 0) throw new Error("live_eval_campaign_frozen");
    if (
      attemptWeight > row.max_calls - row.used_calls ||
      costMicros > row.max_micros - row.used_micros
    )
      throw new Error("live_eval_budget_exhausted");
    db.prepare(
      "INSERT INTO attempts (id,suite,reserved_micros,state) VALUES (?,?,?,'pending')",
    ).run(attemptId, suite, costMicros);
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
      ["live_eval_budget_exhausted", "live_eval_campaign_frozen"].includes(
        error.message,
      )
    )
      throw error;
    throw new Error(CANT_OPEN);
  } finally {
    db?.close();
  }
}

/** Settle one identified dispatched request. Unknown or excess usage freezes the whole campaign. */
export function settlePilotAttempt(file, suite, attemptId, actualMicros) {
  validatePath(file);
  if (
    !SUITES.has(suite) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(attemptId) ||
    (actualMicros !== null &&
      (!Number.isSafeInteger(actualMicros) || actualMicros < 0))
  )
    throw new Error(CANT_OPEN);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
    );
    const meta = db.prepare("SELECT version FROM meta").get();
    const row = db
      .prepare(
        "SELECT suite,reserved_micros,actual_micros,state FROM attempts WHERE id=?",
      )
      .get(attemptId);
    if (!meta || meta.version !== 2 || !row || row.suite !== suite)
      throw new Error(CANT_OPEN);
    if (row.state !== "pending") {
      if (
        (row.state === "unknown" && actualMicros === null) ||
        (row.state === "settled" && row.actual_micros === actualMicros)
      ) {
        db.exec("COMMIT");
        return;
      }
      throw new Error(CANT_OPEN);
    }
    const uncertain =
      actualMicros === null || actualMicros > row.reserved_micros;
    db.prepare("UPDATE attempts SET state=?,actual_micros=? WHERE id=?").run(
      actualMicros === null ? "unknown" : "settled",
      actualMicros,
      attemptId,
    );
    if (uncertain) db.prepare("UPDATE meta SET frozen=1").run();
    db.exec("COMMIT");
  } catch {
    try {
      db?.exec("ROLLBACK");
    } catch {}
    throw new Error(CANT_OPEN);
  } finally {
    db?.close();
  }
}

/** A failed subprocess or unresolved request cannot authorize another suite. */
export function finishPilotSuite(file, suite, succeeded) {
  validatePath(file);
  if (!SUITES.has(suite) || typeof succeeded !== "boolean")
    throw new Error(CANT_OPEN);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
    );
    const meta = db.prepare("SELECT version,frozen FROM meta").get();
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS n FROM attempts WHERE suite=? AND state='pending'",
      )
      .get(suite);
    if (!meta || meta.version !== 2 || !pending) throw new Error(CANT_OPEN);
    if (!succeeded || pending.n > 0)
      db.prepare("UPDATE meta SET frozen=1").run();
    db.exec("COMMIT");
    return succeeded && pending.n === 0 && meta.frozen === 0;
  } catch {
    try {
      db?.exec("ROLLBACK");
    } catch {}
    throw new Error(CANT_OPEN);
  } finally {
    db?.close();
  }
}

/** Freeze even when a malformed usage report cannot be associated with an attempt. */
export function freezePilotLedger(file) {
  validatePath(file);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
    );
    const meta = db.prepare("SELECT version FROM meta").get();
    if (!meta || meta.version !== 2) throw new Error(CANT_OPEN);
    db.prepare("UPDATE meta SET frozen=1").run();
    db.exec("COMMIT");
  } catch {
    try {
      db?.exec("ROLLBACK");
    } catch {}
    throw new Error(CANT_OPEN);
  } finally {
    db?.close();
  }
}
