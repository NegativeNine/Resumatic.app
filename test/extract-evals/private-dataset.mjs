import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { unzipSync, strFromU8 } from "fflate";

const projectRoot = realpathSync(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z
  .object({ path: z.string().min(1).max(240), sha256: Hex })
  .strict();
const Opaque = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const Span = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const Gold = z
  .object({
    roles: z
      .array(
        z
          .object({
            id: Opaque,
            kind: z.enum(["job", "education", "project", "volunteer"]),
            org: z.string().min(1).max(200),
            title: z.string().max(200).nullable(),
            start: z
              .string()
              .regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/)
              .nullable(),
            end: z
              .string()
              .regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/)
              .nullable(),
            current: z.literal(true).optional(),
            unknownEnd: z.literal(true).optional(),
            header: Span,
          })
          .strict(),
      )
      .max(100),
    facts: z
      .array(
        z
          .object({
            id: Opaque,
            role: Opaque.nullable(),
            kind: z.enum(["accomplishment", "skill", "credential"]),
            span: Span,
            level: z
              .enum(["contributed", "implemented", "led", "owned", "founded"])
              .nullable(),
          })
          .strict(),
      )
      .max(1000),
    traps: z
      .array(z.object({ type: z.literal("instruction"), span: Span }).strict())
      .max(100),
  })
  .strict();
const Case = z
  .object({
    id: z.string().regex(/^case-[a-f0-9]{16,64}$/),
    split: z.enum(["dev", "holdout"]),
    origin: z.enum(["synthetic", "real"]),
    format: z.enum(["pdf", "docx"]),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
    // These fields describe independently reviewed source characteristics.
    // They are optional for older manifests but required for full coverage.
    pdfTagged: z.boolean().optional(),
    pageCount: z.number().int().positive().max(1000).optional(),
    documentKind: z.enum(["resume", "academic-cv"]).optional(),
    dateTraps: z.array(z.enum(["odd-date", "numbers-in-dates"])).max(2).optional(),
    layout: z.enum([
      "single-column",
      "two-column",
      "table",
      "scanned",
      "other",
    ]),
    source: Ref,
    markdown: Ref,
    gold: Ref,
    referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    consent: z
      .object({
        granted: z.literal(true),
        scope: z.literal("model-evaluation"),
        receiptRef: Opaque,
        evidence: Ref,
      })
      .strict()
      .nullable(),
    labeling: z
      .object({
        labelerIds: z.array(Opaque).length(2),
        adjudicated: z.literal(true),
        evidence: Ref.nullable(),
      })
      .strict(),
    conversion: z
      .object({
        provider: Opaque,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        pdfMetadataDisabled: z.literal(true),
        evidence: Ref,
      })
      .strict(),
  })
  .strict();
const Manifest = z
  .object({
    version: z.literal(1),
    profile: z.enum(["round-1", "full"]),
    cases: z.array(Case).min(1).max(500),
  })
  .strict();
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) =>
  child === parent || child.startsWith(parent + sep);
const fail = () => {
  throw new Error("private_dataset_invalid");
};

/** All career data stays outside the checkout in an owner-only directory. */
export function privateRoot(path) {
  try {
    if (typeof path !== "string" || !path || !isAbsolute(path)) return fail();
    const root = realpathSync(path);
    if (inside(projectRoot, root)) return fail();
    const st = statSync(root);
    if (
      !st.isDirectory() ||
      (st.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && st.uid !== process.getuid())
    )
      return fail();
    return root;
  } catch {
    return fail();
  }
}
function contained(root, path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((s) => !s || s === "." || s === "..")
  )
    return fail();
  const resolved = realpathSync(join(root, path));
  if (!inside(root, resolved) || inside(projectRoot, resolved)) return fail();
  return resolved;
}
export function readPrivate(rootPath, path, maxBytes) {
  try {
    const root = privateRoot(rootPath);
    const file = contained(root, path);
    const st = statSync(file);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (st.mode & 0o077) !== 0 ||
      st.size > maxBytes ||
      (typeof process.getuid === "function" && st.uid !== process.getuid())
    )
      return fail();
    return readFileSync(file);
  } catch {
    return fail();
  }
}
function text(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail();
  }
}
function checked(root, ref, max) {
  const bytes = readPrivate(root, ref.path, max);
  if (sha256(bytes) !== ref.sha256) return fail();
  return bytes;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function validDocument(source, format) {
  if (format === "pdf") {
    if (
      !source.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
      source.length < 100
    )
      return false;
    const body = source.toString("latin1");
    const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(body);
    if (!match) return false;
    const offset = Number(match[1]);
    return (
      Number.isSafeInteger(offset) &&
      offset > 0 &&
      offset < source.length &&
      /^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(body.slice(offset, offset + 50))
    );
  }
  try {
    const needed = new Set([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ]);
    const parts = unzipSync(source, {
      filter(file) {
        if (!needed.has(file.name)) return false;
        if (
          !Number.isSafeInteger(file.originalSize) ||
          file.originalSize > 2 * 1024 * 1024
        )
          throw new Error();
        return true;
      },
    });
    return (
      [...needed].every((name) => parts[name]?.length > 0) &&
      /<(?:[A-Za-z_][\w.-]*:)?document\b/.test(
        strFromU8(parts["word/document.xml"]),
      )
    );
  } catch {
    return false;
  }
}
function validSpan(span, markdown) {
  return span[0] < span[1] && span[1] <= markdown.length;
}
function validateGold(gold, markdown) {
  if (
    new Set(gold.roles.map((x) => x.id)).size !== gold.roles.length ||
    new Set(gold.facts.map((x) => x.id)).size !== gold.facts.length
  )
    return fail();
  const roles = new Set(gold.roles.map((x) => x.id));
  if (
    gold.roles.some((r) => !validSpan(r.header, markdown) ||
      ((r.current === true || r.unknownEnd === true) && (r.start === null || r.end !== null)) ||
      (r.current === true && r.unknownEnd === true)) ||
    gold.facts.some(
      (f) =>
        !validSpan(f.span, markdown) || (f.role !== null && !roles.has(f.role)) ||
        (f.kind === "skill" && (!markdown.slice(...f.span).trim() || /[\r\n]/.test(markdown.slice(...f.span)))),
    ) ||
    gold.traps.some((t) => !validSpan(t.span, markdown))
  )
    return fail();
  return gold;
}

/** Verify every object before any provider call; errors contain fixed codes only. */
export function loadPrivateDataset(path) {
  try {
    const root = privateRoot(path);
    const bytes = readPrivate(root, "manifest.json", 2 * 1024 * 1024);
    const manifest = Manifest.parse(JSON.parse(text(bytes)));
    const ids = new Set(),
      sourceHashes = new Map(),
      markdownHashes = new Set(),
      consentEvidence = new Set(),
      adjudicationEvidence = new Set();
    const cases = manifest.cases.map((entry) => {
      if (ids.has(entry.id)) return fail();
      ids.add(entry.id);
      if ((entry.format !== "pdf" && entry.pdfTagged !== undefined) ||
          (entry.dateTraps && new Set(entry.dateTraps).size !== entry.dateTraps.length))
        return fail();
      if (
        entry.origin === "real" &&
        (!entry.consent || !entry.labeling.evidence)
      )
        return fail();
      if (entry.consent) {
        if (consentEvidence.has(entry.consent.evidence.sha256)) return fail();
        consentEvidence.add(entry.consent.evidence.sha256);
        const consent = JSON.parse(
          text(checked(root, entry.consent.evidence, 256 * 1024)),
        );
        if (
          !same(consent, {
            version: 1,
            caseId: entry.id,
            sourceSha256: entry.source.sha256,
            granted: true,
            scope: "model-evaluation",
            receiptRef: entry.consent.receiptRef,
          })
        )
          return fail();
      }
      if (entry.labeling.evidence) {
        if (adjudicationEvidence.has(entry.labeling.evidence.sha256))
          return fail();
        adjudicationEvidence.add(entry.labeling.evidence.sha256);
        const labeling = JSON.parse(
          text(checked(root, entry.labeling.evidence, 256 * 1024)),
        );
        if (
          !same(labeling, {
            version: 1,
            caseId: entry.id,
            sourceSha256: entry.source.sha256,
            markdownSha256: entry.markdown.sha256,
            goldSha256: entry.gold.sha256,
            labelerIds: entry.labeling.labelerIds,
            adjudicated: true,
          })
        )
          return fail();
      }
      const conversion = JSON.parse(
        text(checked(root, entry.conversion.evidence, 256 * 1024)),
      );
      if (
        !same(conversion, {
          version: 1,
          caseId: entry.id,
          sourceSha256: entry.source.sha256,
          markdownSha256: entry.markdown.sha256,
          provider: entry.conversion.provider,
          date: entry.conversion.date,
          pdfMetadataDisabled: true,
          sourceReadable: true,
          conversionReviewed: true,
        })
      )
        return fail();
      if (entry.origin === "synthetic" && entry.consent) return fail();
      if (new Set(entry.labeling.labelerIds).size !== 2) return fail();
      const source = checked(root, entry.source, 10 * 1024 * 1024);
      if (!validDocument(source, entry.format)) return fail();
      // Identical source documents may never appear in both splits or as duplicates.
      if (sourceHashes.has(entry.source.sha256)) return fail();
      sourceHashes.set(entry.source.sha256, entry.split);
      if (markdownHashes.has(entry.markdown.sha256)) return fail();
      markdownHashes.add(entry.markdown.sha256);
      const markdown = text(checked(root, entry.markdown, 4 * 60_000));
      if (!markdown.trim() || markdown.length > 60_000) return fail();
      const gold = validateGold(
        Gold.parse(JSON.parse(text(checked(root, entry.gold, 1024 * 1024)))),
        markdown,
      );
      return {
        id: entry.id,
        split: entry.split,
        markdown,
        referenceDate: entry.referenceDate,
        gold,
        meta: {
          origin: entry.origin,
          format: entry.format,
          language: entry.language,
          layout: entry.layout,
          pdfTagged: entry.pdfTagged,
          pageCount: entry.pageCount,
          documentKind: entry.documentKind,
          dateTraps: entry.dateTraps ?? [],
        },
      };
    });
    return { root, manifestHash: sha256(bytes), cases, manifest };
  } catch {
    return fail();
  }
}

export function createPrivateSnapshot(rootPath, snapshot) {
  try {
    const root = privateRoot(rootPath);
    const dir = join(root, "evaluation-snapshots");
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    const actual = realpathSync(dir),
      st = lstatSync(dir);
    if (
      actual !== dir ||
      !st.isDirectory() ||
      (st.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && st.uid !== process.getuid())
    )
      return fail();
    if (!/^[a-f0-9-]{36}$/.test(snapshot.runId)) return fail();
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > 30 * 1024 * 1024) return fail();
    writeFileSync(join(dir, `${snapshot.runId}.json`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    return { runId: snapshot.runId, sha256: sha256(bytes) };
  } catch {
    return fail();
  }
}

export function readPrivateJson(root, path, max = 30 * 1024 * 1024) {
  try {
    const bytes = readPrivate(root, path, max);
    return { bytes, value: JSON.parse(text(bytes)), sha256: sha256(bytes) };
  } catch {
    return fail();
  }
}
