// What the record keeps beside a person's own lines: how a line divides into parts, which taxonomy
// concepts a line or a role shows, and which facts or roles say the same thing. Each is a
// judgement about a line and never a change to it. This file is the vocabulary and the rules that
// need no storage; src/vault/record.ts keeps them, and docs/record.md says what each is for.

import { validConceptId } from "../taxonomy/ids.mjs";
import { CONCEPT_KINDS, type ConceptKind } from "../taxonomy/types";
import { cleanExtractedText } from "./clean";

// ---------------------------------------------------------------- judgements

export const JUDGEMENT_STATES = ["proposed", "confirmed", "rejected"] as const;
export type JudgementState = (typeof JUDGEMENT_STATES)[number];

/** A rule in the code, a model, or the person whose record it is. */
export const PROPOSERS = ["rule", "model", "owner"] as const;
export type Proposer = (typeof PROPOSERS)[number];

/** What made a judgement. Stamped on it when it is made and kept whatever is decided later. */
export interface Stamp {
  proposedBy: Proposer;
  /** The model that made it. Null unless a model did. */
  model: string | null;
  /** The rule or check that produced it, with its version: "identical-wording/2". */
  method: string;
  /** The taxonomy build it was made against. Every tag has one. */
  taxonomyVersion: string | null;
  /** How sure the check was, from 0 to 1, where it says. */
  confidence: number | null;
  /** Stored to be measured and shown to nobody. Only measurement reads a shadow judgement. */
  shadow: boolean;
}

export interface Judgement extends Stamp {
  id: string;
  state: JudgementState;
  createdAt: number;
  /** Who confirmed or rejected it. Null while it is only proposed. A model never decides. */
  decidedBy: "rule" | "owner" | null;
  decidedAt: number | null;
}

const METHOD = /^[a-z][a-z0-9-]{0,39}(?:\/[a-z0-9][a-z0-9.-]{0,19})?$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/;
const MODEL = /^[\x21-\x7e]{1,200}$/;

/** Why a stamp can't be stored, or null when it can. */
export function stampProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") return "a judgement says what made it";
  const stamp = value as Partial<Stamp>;
  if (!PROPOSERS.includes(stamp.proposedBy as Proposer)) return "a judgement is made by a rule, a model or the owner";
  if (stamp.proposedBy === "model") {
    if (typeof stamp.model !== "string" || !MODEL.test(stamp.model)) return "a model's judgement names the model";
  } else if (stamp.model !== null) return "only a model's judgement names a model";
  if (typeof stamp.method !== "string" || !METHOD.test(stamp.method)) return "a judgement names the rule or check that made it";
  if (stamp.taxonomyVersion !== null && (typeof stamp.taxonomyVersion !== "string" || !VERSION.test(stamp.taxonomyVersion)))
    return "unknown taxonomy version";
  if (stamp.confidence !== null && (typeof stamp.confidence !== "number" || !(stamp.confidence >= 0 && stamp.confidence <= 1)))
    return "confidence is between 0 and 1";
  if (typeof stamp.shadow !== "boolean") return "a judgement says whether it is in shadow";
  // What the owner does is theirs and is never hidden from them.
  if (stamp.proposedBy === "owner" && (stamp.shadow || stamp.confidence !== null)) return "the owner's own judgement is neither in shadow nor scored";
  return null;
}

// ---------------------------------------------------------------- parts of a line

/** [start, end) in a fact's text, counted as JavaScript counts a string. */
export type Range = [start: number, end: number];

export const PART_KINDS = [
  /** One claim the line makes: its verb and everything the verb governs. */
  "clause",
  /** A claim that states an outcome of another. */
  "result",
  /** A tool, a named thing or a figure inside a claim. Never a claim by itself. */
  "mention",
] as const;
export type PartKind = (typeof PART_KINDS)[number];

export interface NewPart {
  kind: PartKind;
  ranges: Range[];
  /** For a result: the position, in the same list, of the claim it is an outcome of. */
  resultOf?: number | null;
}

export interface FactPart {
  id: string;
  kind: PartKind;
  ranges: Range[];
  /** The part's words: its ranges of the line, in order, and nothing else. */
  text: string;
  /** For a result: the part it is an outcome of. */
  resultOf: string | null;
}

/** One way a line divides. A line has at most one that hasn't been rejected. */
export interface FactSplit extends Judgement {
  factId: string;
  parts: FactPart[];
}

export const MAX_SPLIT_PARTS = 24;
export const MAX_PART_RANGES = 8;

// A range is made of whole runs of the line: stretches with no space in them, such as "co-founder",
// "$1.2M", "40%", "CI/CD" or "didn't". It can never begin or end inside one, so a part can't turn
// "unhelpful" into "helpful", "co-founder" into "founder", or "-5%" into "5". The one thing a range
// may leave off is punctuation that wraps a run: brackets and quotes before it, and brackets,
// quotes and sentence punctuation after it. An em dash separates runs as a space does.
const SEPARATOR = /[\s\u2014]/u;
const OPENERS = new Set(["(", "[", "{", '"', "'", "\u2018", "\u201C", "\u00AB"]);
const CLOSERS = new Set([")", "]", "}", '"', "'", "\u2019", "\u201D", "\u00BB", ",", ";", ":", ".", "!", "?"]);

/** One run of a line: a stretch with no space in it, and the core left without the punctuation that wraps it. */
export interface LineRun {
  start: number;
  /** Where the run's own characters start, after any opening brackets or quotes. */
  coreStart: number;
  /** Where they end, before any closing brackets, quotes or sentence punctuation. */
  coreEnd: number;
  end: number;
}

/** The runs of a line, in order. A run of nothing but punctuation is its own core. */
export function lineRuns(line: string): LineRun[] {
  const runs: LineRun[] = [];
  let at = 0;
  while (at < line.length) {
    if (SEPARATOR.test(line[at]!)) {
      at++;
      continue;
    }
    let stop = at;
    while (stop < line.length && !SEPARATOR.test(line[stop]!)) stop++;
    let core = at;
    while (core < stop && OPENERS.has(line[core]!)) core++;
    let coreEnd = stop;
    while (coreEnd > core && CLOSERS.has(line[coreEnd - 1]!)) coreEnd--;
    // Nothing but punctuation: taken whole or not at all.
    runs.push(coreEnd === core ? { start: at, coreStart: at, coreEnd: stop, end: stop } : { start: at, coreStart: core, coreEnd, end: stop });
    at = stop;
  }
  return runs;
}

export interface RangeEdges {
  /** starts[i] is 1 where a range may start at i. */
  starts: Uint8Array;
  /** ends[i] is 1 where a range may end at i. */
  ends: Uint8Array;
}

/** Every place in a line where a range may start, and every place where one may end. */
export function rangeEdges(line: string): RangeEdges {
  const starts = new Uint8Array(line.length + 1);
  const ends = new Uint8Array(line.length + 1);
  for (const run of lineRuns(line)) {
    for (let i = run.start; i <= run.coreStart; i++) starts[i] = 1;
    for (let i = run.coreEnd; i <= run.end; i++) ends[i] = 1;
  }
  return { starts, ends };
}

/** Why these ranges can't be one part of the line, or null when they can. */
export function rangesProblem(line: string, ranges: unknown, edges: RangeEdges = rangeEdges(line)): string | null {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > MAX_PART_RANGES)
    return `a part has between one and ${MAX_PART_RANGES} ranges`;
  let floor = 0;
  for (const range of ranges as unknown[]) {
    if (!Array.isArray(range) || range.length !== 2) return "a range is a start and an end";
    const [start, end] = range as [unknown, unknown];
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end))
      return "a range is a start and an end";
    if (start < 0 || end > line.length || start >= end) return "a range lies inside its line";
    if (start < floor) return "the ranges of a part are in order and apart";
    if (!edges.starts[start] || !edges.ends[end]) return "a range starts and ends on whole words";
    // Two ranges of one part always have something between them, so joining never fuses words.
    floor = end + 1;
  }
  return null;
}

/** A part's words: its ranges of the line, in order, with one space between them. */
export function partText(line: string, ranges: readonly Range[]): string {
  return ranges.map(([start, end]) => line.slice(start, end)).join(" ");
}

/**
 * Why these parts can't be stored as one way the line divides, or null when they can. This is
 * only what can be told from positions. Whether a part means what the line means is checked
 * where the split is made, and a split that passes here can still be refused there.
 */
export function partsProblem(line: string, parts: unknown): string | null {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_SPLIT_PARTS)
    return `a line divides into between one and ${MAX_SPLIT_PARTS} parts`;
  const edges = rangeEdges(line);
  const seen = new Set<string>();
  for (const value of parts as unknown[]) {
    if (!value || typeof value !== "object") return "unknown kind of part";
    const part = value as Partial<NewPart>;
    if (!PART_KINDS.includes(part.kind as PartKind)) return "unknown kind of part";
    const problem = rangesProblem(line, part.ranges, edges);
    if (problem) return problem;
    const key = JSON.stringify([part.kind === "mention" ? "mention" : "claim", part.ranges]);
    if (seen.has(key)) return "two parts are the same";
    seen.add(key);
  }
  const list = parts as NewPart[];
  if (!list.some((part) => part.kind === "clause")) return "a line divides into at least one clause";
  for (const [index, part] of list.entries()) {
    if (part.kind !== "result") {
      if ((part.resultOf ?? null) !== null) return "only a result is an outcome of another part";
      continue;
    }
    // A result leads, through other results if need be, to a clause.
    let current = index;
    for (let steps = 0; ; steps++) {
      const target = list[current]!.resultOf;
      if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target >= list.length || target === current || steps >= list.length)
        return "a result names the claim it is an outcome of";
      const kind = list[target]!.kind;
      if (kind === "clause") break;
      if (kind !== "result") return "a result names the claim it is an outcome of";
      current = target;
    }
  }
  const claims = list.filter((part) => part.kind !== "mention");
  for (const mention of list.filter((part) => part.kind === "mention")) {
    const inside = claims.some((claim) =>
      mention.ranges.every(([start, end]) => claim.ranges.some(([from, to]) => from <= start && end <= to)));
    if (!inside) return "a mention lies inside a clause";
  }
  return null;
}

// ---------------------------------------------------------------- tags

export const TAG_SUBJECTS = ["fact", "part", "role"] as const;
export type TagSubjectKind = (typeof TAG_SUBJECTS)[number];

export const TAG_RELATIONS = [
  /** A fact or part shows a skill or a piece of knowledge. */
  "shows",
  /** A fact or part uses a tool. */
  "uses",
  /** A fact or part is a work activity or a task. */
  "does",
  /** A role is closest to this occupation. */
  "occupation",
] as const;
export type TagRelation = (typeof TAG_RELATIONS)[number];

export interface TagSubject {
  kind: TagSubjectKind;
  id: string;
}

/**
 * How a concept of this kind relates to what it tags, or null when it can't tag it. A role is
 * tagged only with occupations, and only a role is: what a role shows is what its facts show.
 */
export function tagRelation(subject: TagSubjectKind, kind: ConceptKind): TagRelation | null {
  if (kind === "occupation" || kind === "occupation-group") return subject === "role" ? "occupation" : null;
  if (subject === "role") return null;
  if (kind === "tool" || kind === "tool-category") return "uses";
  if (kind === "activity" || kind === "task") return "does";
  return "shows";
}

export interface NewTag {
  subject: TagSubject;
  conceptId: string;
  conceptKind: ConceptKind;
  /** The concept's preferred label when the tag was made, so a tag can be read without the taxonomy. */
  label: string;
  stamp: Stamp;
}

export interface ConceptTag extends Judgement {
  subject: TagSubject;
  conceptId: string;
  conceptKind: ConceptKind;
  label: string;
  relation: TagRelation;
  taxonomyVersion: string;
}

export const MAX_TAG_LABEL_CHARS = 300;
/** Tags kept for one fact, part or role, whatever was decided about them. */
export const MAX_TAGS_PER_SUBJECT = 64;

/** Why a tag can't be stored, or null when it can. It says nothing about whether the concept exists. */
export function tagProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") return "a tag names what it tags and a concept";
  const tag = value as Partial<NewTag>;
  const subject = tag.subject as Partial<TagSubject> | undefined;
  if (!subject || !TAG_SUBJECTS.includes(subject.kind as TagSubjectKind) || !validId(subject.id))
    return "a tag is on a fact, a part or a role";
  if (!validConceptId(tag.conceptId)) return "a tag names a concept of the taxonomy";
  if (!CONCEPT_KINDS.includes(tag.conceptKind as ConceptKind)) return "a tag says what kind of concept it names";
  if (!tagRelation(subject.kind as TagSubjectKind, tag.conceptKind as ConceptKind))
    return subject.kind === "role" ? "a role is tagged with an occupation" : "an occupation tags a role";
  if (typeof tag.label !== "string" || !tag.label.trim() || tag.label.length > MAX_TAG_LABEL_CHARS || tag.label !== tag.label.trim())
    return "a tag carries its concept's label";
  const problem = stampProblem(tag.stamp);
  if (problem) return problem;
  if (tag.stamp!.taxonomyVersion === null) return "a tag says which taxonomy it was made against";
  return null;
}

// ---------------------------------------------------------------- links

export const LINK_KINDS = ["fact", "role"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_RELATIONS = [
  /** `from` says what `to` says. Once confirmed, `to` stands for both and keeps both quotes. */
  "same",
  /** `from` says everything `to` says, and more. Both stay; they are shown together. */
  "fuller",
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface NewLink {
  kind: LinkKind;
  from: string;
  to: string;
  relation: LinkRelation;
  stamp: Stamp;
  /**
   * Confirm at once, without asking. Only a rule may, only for "same", and only where the record
   * itself can see the two are identical: two facts of one kind with the same wording in one
   * role, two skills or credentials that stand outside any role, or two roles alike in every field.
   */
  confirm?: boolean;
}

export interface RecordLink extends Judgement {
  kind: LinkKind;
  from: string;
  to: string;
  relation: LinkRelation;
  /**
   * True while the link is in effect: confirmed, not in shadow, and, between two facts, while
   * both sit in one role. A confirmed link between facts stops holding when their roles are
   * separated and holds again when they are rejoined.
   */
  holds: boolean;
}

/** Links kept on one fact or role, in either direction, whatever was decided about them. */
export const MAX_LINKS_PER_ITEM = 128;

/** Why a link can't be stored, or null when it can. It says nothing about the two items themselves. */
export function linkProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") return "a link joins two facts or two roles";
  const link = value as Partial<NewLink>;
  if (!LINK_KINDS.includes(link.kind as LinkKind)) return "a link joins two facts or two roles";
  if (!LINK_RELATIONS.includes(link.relation as LinkRelation)) return "unknown kind of link";
  if (link.relation === "fuller" && link.kind !== "fact") return "only a fact is a fuller version of another";
  if (!validId(link.from) || !validId(link.to) || link.from === link.to) return "a link joins two different items";
  const problem = stampProblem(link.stamp);
  if (problem) return problem;
  if (link.confirm !== undefined && typeof link.confirm !== "boolean") return "confirm is true or false";
  if (link.confirm && (link.stamp!.proposedBy !== "rule" || link.relation !== "same" || link.stamp!.shadow))
    return "only a rule's finding that two items are identical is confirmed without asking";
  return null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

/**
 * One quote that supports a fact. A fact that others were merged into is supported by its own
 * quote and by each of theirs, so it keeps the quote from every upload that states it.
 */
export interface FactEvidence {
  /** The fact the quote was read for: the fact asked about, or one merged into it. */
  factId: string;
  /** True for the fact's own quote. */
  own: boolean;
  sourceId: string;
  quote: string;
  /** Where the quote sits in its upload's text, where that is known. */
  span: Range | null;
}

/** Everything the record holds, as the owner's export gives it. Shadow judgements are included and say so. */
export interface RecordExport {
  factSplits: FactSplit[];
  conceptTags: ConceptTag[];
  recordLinks: RecordLink[];
}

// ---------------------------------------------------------------- identical wording, identical roles

// The only list markers that are never part of what a line says: a bullet, and a dash, a plus
// or a heading mark with a word after it. A number is not one, and neither is a dash, a plus or
// a hash before a figure. Text read from an upload lost its list numbers when it was read, so a
// number a line still starts with was typed there: "1. Staatsexamen" is not "2. Staatsexamen",
// and "- 5% churn" is not "+ 5% churn".
const BULLETS = /^(?:(?:[*•▪●‣◦]|[-+–](?=\s+[*`]*\p{L})|#{1,6}(?=\s+[*`]*\p{L}))\s+)+/u;

/**
 * A line with only its presentation removed: bullets and paired Markdown marks, runs of
 * spaces, the shape of quotation marks, and one full stop at the very end. Case, numbers, dates
 * and every other mark stay, because any of them can carry meaning. That includes a number or a
 * sign the line starts with.
 */
export function wording(text: string): string {
  return cleanExtractedText(text.normalize("NFC"), BULLETS)
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/(?<=[\p{L}\p{N})\]"'%])\.$/u, "");
}

/** True when two lines are the same words. This is the only likeness that merges without asking. */
export function sameWording(a: string, b: string): boolean {
  const left = wording(a);
  return left.length > 0 && left === wording(b);
}

/** The fields that say which job, course or project a role is. */
export interface RoleIdentity {
  kind: string;
  org: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  unknownEndStartDate?: string | null;
}

/**
 * What names a role, as one value that two roles share exactly when they are alike in every
 * field that names a role: the same kind, organisation and title, the same known start, and the
 * same end or none, which states a role as current. Null when the fields can't settle which
 * role this is: no title, no known start, or an end that is not known.
 */
export function roleKey(role: RoleIdentity): string | null {
  const org = wording(role.org);
  const title = role.title === null ? "" : wording(role.title);
  if (!org || !title || role.unknownEndStartDate || !role.startDate) return null;
  return JSON.stringify([role.kind, org, title, role.startDate, role.endDate]);
}

/**
 * True when two roles are alike in every field that names a role. A missing title, an unknown
 * date or a date written more exactly in one than the other settles nothing, so such roles are
 * offered to the owner instead.
 */
export function sameRole(a: RoleIdentity, b: RoleIdentity): boolean {
  const key = roleKey(a);
  return key !== null && key === roleKey(b);
}
