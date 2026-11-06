import {
  constants,
  closeSync,
  lstatSync,
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
// A one-shot campaign contains at most 50 attempts and never deletes rows.
// This is deliberately far larger than its expected SQLite database, while
// bounding the size of a malformed file supplied to the read-only audit.
const MAX_AUDIT_FILE_BYTES = 8 * 1024 * 1024;

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
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE meta (version INTEGER NOT NULL, total_micros INTEGER NOT NULL, total_calls INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 0); CREATE TABLE budgets (suite TEXT PRIMARY KEY, max_micros INTEGER NOT NULL, max_calls INTEGER NOT NULL, used_micros INTEGER NOT NULL DEFAULT 0, used_calls INTEGER NOT NULL DEFAULT 0); CREATE TABLE attempts (id TEXT PRIMARY KEY, suite TEXT NOT NULL, reserved_micros INTEGER NOT NULL, reserved_calls INTEGER NOT NULL, actual_micros INTEGER, state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown')));",
    );
    db.prepare(
      "INSERT INTO meta (version,total_micros,total_calls) VALUES (3,?,?)",
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
      meta.version !== 3 ||
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
      "INSERT INTO attempts (id,suite,reserved_micros,reserved_calls,state) VALUES (?,?,?,?,'pending')",
    ).run(attemptId, suite, costMicros, attemptWeight);
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
    if (!meta || ![2, 3].includes(meta.version) || !row || row.suite !== suite)
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
    if (!meta || ![2, 3].includes(meta.version) || !pending) throw new Error(CANT_OPEN);
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
    if (!meta || ![2, 3].includes(meta.version)) throw new Error(CANT_OPEN);
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

/** Read one consistent, bounded local accounting snapshot without changing it. */
export function auditPilotLedger(file) {
  validatePath(file);
  let db;
  try {
    let bytes = statSync(file).size;
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      let sidecar;
      try { sidecar = lstatSync(`${file}${suffix}`); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (!sidecar.isFile() || sidecar.nlink !== 1 || (sidecar.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && sidecar.uid !== process.getuid())) throw new Error();
      bytes += sidecar.size;
    }
    if (bytes > MAX_AUDIT_FILE_BYTES) throw new Error();
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout=10000; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new Error();
    db.exec("BEGIN");
    // The one-shot ledger uses ordinary tables, never views or virtual
    // tables. Refuse a substituted schema before selecting its contents.
    const schema = db.prepare(`SELECT name,type,CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=4096 THEN sql ELSE NULL END AS definition FROM sqlite_schema WHERE name IN ('meta','budgets','attempts') LIMIT 4`).all();
    if (schema.length !== 3 || new Set(schema.map((row) => row.name)).size !== 3 ||
        schema.some((row) => row.type !== "table" || typeof row.definition !== "string" || !/^\s*CREATE\s+TABLE\b/i.test(row.definition)))
      throw new Error();
    // Validate malformed values inside SQLite so large TEXT/BLOB cells are not
    // copied into JavaScript. Counts are capped before .all() allocates arrays.
    const number = (name) => `CASE WHEN typeof(${name})='integer' THEN ${name} ELSE NULL END AS ${name}`;
    const nullableNumber = (name) => `CASE WHEN typeof(${name})='integer' THEN ${name} WHEN ${name} IS NULL THEN NULL ELSE -1 END AS ${name}`;
    const text = (name, maxBytes) => `CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB))<=${maxBytes} THEN ${name} ELSE NULL END AS ${name}`;
    const metaRows = db.prepare(`SELECT ${["version", "total_micros", "total_calls", "frozen"].map(number).join(",")} FROM meta LIMIT 2`).all();
    const budgets = db.prepare(`SELECT ${text("suite", 10)},${["max_micros", "max_calls", "used_micros", "used_calls"].map(number).join(",")} FROM budgets LIMIT 3`).all();
    const m = metaRows[0];
    if (metaRows.length !== 1 || ![2, 3].includes(m.version)) throw new Error();
    const calls = m.version === 3 ? number("reserved_calls") : "NULL AS reserved_calls";
    const rows = db.prepare(`SELECT ${text("id", 100)},${text("suite", 10)},${number("reserved_micros")},${calls},${nullableNumber("actual_micros")},${text("state", 16)} FROM attempts LIMIT 51`).all();
    budgets.sort((a, b) => typeof a.suite === "string" && typeof b.suite === "string" ? (a.suite < b.suite ? -1 : a.suite > b.suite ? 1 : 0) : 0);
    const nonnegative = (n) => Number.isSafeInteger(n) && n >= 0;
    if (!integer(m.total_micros) || m.total_micros > 10_000_000 ||
        !integer(m.total_calls) || m.total_calls > 50 || ![0, 1].includes(m.frozen) ||
        budgets.length !== 2 || budgets[0].suite !== "extraction" || budgets[1].suite !== "tailoring" ||
        budgets.some((b) => !integer(b.max_micros) || !integer(b.max_calls) || !nonnegative(b.used_micros) ||
          !nonnegative(b.used_calls) || b.used_micros > b.max_micros || b.used_calls > b.max_calls) ||
        budgets.reduce((n, b) => n + b.max_micros, 0) !== m.total_micros ||
        budgets.reduce((n, b) => n + b.max_calls, 0) !== m.total_calls || rows.length > 50 ||
        rows.some((row) => typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) || !SUITES.has(row.suite) ||
          !integer(row.reserved_micros) || (m.version === 3 && !integer(row.reserved_calls)) || !["pending", "settled", "unknown"].includes(row.state) ||
          (row.actual_micros !== null && !nonnegative(row.actual_micros)) ||
          (row.state === "settled" && row.actual_micros === null) ||
          (row.state !== "settled" && row.actual_micros !== null)) ||
        (m.frozen !== 1 && rows.some((row) => row.state === "unknown" ||
          (row.state === "settled" && row.actual_micros > row.reserved_micros))) ||
        budgets.some((b) => {
          const group = rows.filter((row) => row.suite === b.suite);
          return group.reduce((n, row) => n + row.reserved_micros, 0) !== b.used_micros ||
            (m.version === 3 ? group.reduce((n, row) => n + row.reserved_calls, 0) !== b.used_calls :
              b.used_calls < group.length || (group.length === 0 && b.used_calls !== 0));
        })) throw new Error();
    db.exec("COMMIT");
    rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { totalMicros: m.total_micros, totalCalls: m.total_calls, frozen: m.frozen === 1,
      budgets: budgets.map((b) => ({ suite: b.suite, reservedMicros: b.used_micros, reservedCalls: b.used_calls })),
      attempts: rows.map((row) => ({ id: row.id, suite: row.suite, reservedMicros: row.reserved_micros, reservedCalls: row.reserved_calls,
        state: row.state === "settled" && row.actual_micros > row.reserved_micros ? "overrun" : row.state,
        actualMicros: row.actual_micros })) };
  } catch {
    try { db?.exec("ROLLBACK"); } catch {}
    throw new Error(CANT_OPEN);
  } finally { db?.close(); }
}
