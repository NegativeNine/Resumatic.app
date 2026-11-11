import type { Models } from "../ai/models";
import { JudgeOut, judgePrompt, type JudgeItem } from "../ai/prompts";
import { errorCode } from "../shared/errors";
import type { Stamp } from "../shared/record";
import { LABEL_TYPES, normalizeLabel, words, type Concept, type ConceptKind, type LabelType, type Mention, type Taxonomy } from "../taxonomy";

// Tagging facts and job roles with taxonomy concepts (step 5 of docs/taxonomy-pipelines-design.md).
//
// A tag says that a line shows a concept of the taxonomy: software it uses, something it knows,
// a kind of work it does. On a job it says which occupation the job is. Tags are worked out for
// one upload at a time, and every one is held to these rules:
//   1. a candidate is only ever one of the taxonomy's own concepts whose label stands, word for
//      word, in the fact's text or the job's title. No model names a concept, so none is made up;
//   2. a job's candidates are occupations, and only a job's are: an occupation named in a line
//      is usually someone else's;
//   3. what an occupation usually involves (`profile`) puts a fact's likelier candidates first.
//      It adds none and decides none;
//   4. a candidate becomes a tag in one of two ways. A rule that needs no model tags a listed
//      skill that is one label and nothing else (`skillRule`). Every other candidate is put to
//      the judge, in the form it already answers, and needs one plain yes from the call that
//      asked about it;
//   5. no tag means unknown. It is never a finding that the person lacks the experience.
// Nothing here stores anything. Every read of the taxonomy is made before anything is asked, and
// the caller is handed the tags as they are decided, to keep in shadow (docs/tagging.md).
//
// Whatever is over a cap is left untagged, and counted in the report:
//
//   MAX_TAG_ROLES        20     more jobs than a resume lists
//   MAX_TAG_FACTS        120    a long resume's lines and skills
//   MAX_TAG_WORDS        3,000  six lookups a word, 74 to a D1 statement: under 400 statements
//   MAX_ROLE_CANDIDATES  4      two labels in a title, each in both sources
//   MAX_FACT_CANDIDATES  6      three things in a line, each in both sources
//   MAX_TAG_PROFILES     8      a profile is the dearest read
//   MAX_TAG_QUESTIONS    120    what offers may ask in its one three-minute try

/**
 * What made a tag, stamped on it. A method names where the candidate came from, a label found in
 * the subject's own words, and what decided it: the judge, or the rule for a listed skill. Raise
 * a method's number when its rule or the table of questions changes.
 */
export const TAG_JUDGE_METHOD = "mention-judge/1";
export const TAG_RULE_METHOD = "mention-label/1";
export type TagMethod = typeof TAG_JUDGE_METHOD | typeof TAG_RULE_METHOD;

export const MAX_TAG_ROLES = 20;
export const MAX_TAG_FACTS = 120;
export const MAX_TAG_WORDS = 3000;
export const MAX_ROLE_CANDIDATES = 4;
export const MAX_FACT_CANDIDATES = 6;
export const MAX_TAG_PROFILES = 8;
export const MAX_TAG_QUESTIONS = 120;
/** The most tags one upload can be given: every job and every fact with as many as it may have. */
export const MAX_TAGS_PER_SAVE = MAX_TAG_ROLES * MAX_ROLE_CANDIDATES + MAX_TAG_FACTS * MAX_FACT_CANDIDATES;

/** The kinds of concept that can tag a fact. A job is tagged with occupations, and only a job is. */
export const FACT_TAG_KINDS = ["skill", "knowledge", "skill-group", "activity", "tool", "tool-category"] as const;
const ROLE_TAG_KINDS = ["occupation"] as const;
/** A kind of concept that can tag something: one of a fact's kinds, or an occupation. */
export type TagKind = (typeof FACT_TAG_KINDS)[number] | (typeof ROLE_TAG_KINDS)[number];

const QUESTIONS_PER_CALL = 20;

/** The reads tagging makes of the taxonomy. None of them decides what a text means. */
export type TagReads = Pick<Taxonomy, "mentions" | "lookup" | "get" | "profile">;

/** What a run's tags are made with: the judge model it asks, and the taxonomy build it reads. */
export interface TagMade {
  model: string;
  taxonomyVersion: string;
}

/** A shadow tag already stored for a row, or for another row that says the same words. */
export interface HeldTag {
  conceptId: string;
  method: string;
  model: string | null;
  taxonomyVersion: string | null;
  /** True when the row itself holds the tag, false when another row with the same words does. */
  own: boolean;
}

/** What one upload has to tag, as the vault reads it for the run. */
export interface TagSubjects {
  roles: { id: string; title: string; held: HeldTag[] }[];
  facts: {
    id: string;
    roleId: string | null;
    kind: string;
    text: string;
    /** For a skill: its text is, character for character, one whole item of the line it was read from. */
    asWritten: boolean;
    held: HeldTag[];
  }[];
  /** How many job roles and facts the upload has in all. `roles` and `facts` are the first of them. */
  total: { roles: number; facts: number };
}

/** A tag that was decided, for the caller to keep. */
export interface ProposedTag {
  subject: { kind: "fact" | "role"; id: string };
  /** The fact's text or the job's title as it was decided about. A tag is kept only while the row still says exactly this. */
  words: string;
  conceptId: string;
  conceptKind: ConceptKind;
  label: string;
  method: typeof TAG_JUDGE_METHOD | typeof TAG_RULE_METHOD;
}

/** What a run did, in numbers only: no line, title or label is kept in it. */
export interface TagReport {
  /** Job roles and facts whose words were looked through. */
  roles: number;
  facts: number;
  /** Candidates kept once each role and each fact was cut to as many as it may have. */
  candidates: number;
  /** Candidates whose row already holds the tag from the same decider: not asked about, not proposed. */
  known: number;
  /** Tags proposed without asking, because another row with the same words holds the judge's yes. */
  carried: number;
  /** Tags the rule proposed. */
  byRule: number;
  /** Questions sent to the judge, counted as each call is sent. One question can stand for several rows. */
  asked: number;
  /** Questions it answered with one plain yes. */
  yes: number;
  /** Tags the caller kept, and tags it refused. */
  stored: number;
  refused: number;
  /**
   * What a cap left untagged, which means unknown. Rows: `subjects` beyond the first roles and
   * facts, and `words` beyond the words looked through. Candidates: `per_role` and `per_fact`
   * beyond what one row may have, and `per_upload` beyond the questions one upload may ask.
   */
  left: { subjects: number; words: number; per_role: number; per_fact: number; per_upload: number };
  /** Why the run ended early, as a code. Absent when it ran to its end. */
  failed?: string;
}

export function emptyTagReport(): TagReport {
  return { roles: 0, facts: 0, candidates: 0, known: 0, carried: 0, byRule: 0, asked: 0, yes: 0, stored: 0, refused: 0, left: { subjects: 0, words: 0, per_role: 0, per_fact: 0, per_upload: 0 } };
}

/** The stamp of a tag made by this method in this run. Every one is in shadow, proposed, and unscored. */
export function tagStamp(method: TagMethod, made: TagMade): Stamp {
  const rule = method === TAG_RULE_METHOD;
  return { proposedBy: rule ? "rule" : "model", model: rule ? null : made.model, method, taxonomyVersion: made.taxonomyVersion, confidence: null, shadow: true };
}

// ---------------------------------------------------------------- the rule that needs no model

/** True when two texts are the same letters: equal once case and the encoding of accents are set aside, with nothing else removed. */
export function sameLetters(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

/** True when a skill's text is, character for character, one whole item of the line it was read from. */
export function skillAsWritten(quote: string | null, text: string): boolean {
  if (!quote || !text) return false;
  return quote.trim().replace(/^(?:[-*+•]\s+|#{1,6}\s+)/u, "").split(/[,;|\t•:\n]/u).some((item) => item.trim() === text);
}

/**
 * The one concept a listed skill names beyond doubt, or null when it must be asked about. A
 * skill's text is the reading model's own string, kept when it matches an item of a list once
 * case and Markdown marks are set aside, so a list that says "sql" can be stored as "SQL". The
 * rule therefore needs all of: the text is the upload's own item, character for character
 * (`asWritten`); the labels found in it are one label, firm, of one concept; that label is the
 * source's own name for the concept or another the source lists, never a hidden term or one the
 * builder made; and the text is that label and nothing else, apart from letter case. A mark
 * beside the label ("SQL ✗") or between its words ("Microsoft ✗ Excel") is something else.
 *
 * `mentions` are the labels found in the text among the kinds that can tag a fact. The caller
 * proposes the tag only if looking the text up among every kind then gives this concept alone.
 */
export function skillRule(fact: { kind: string; text: string; asWritten: boolean }, mentions: readonly Mention[]): Mention["concepts"][number] | null {
  if (fact.kind !== "skill" || !fact.asWritten || mentions.length !== 1) return null;
  const mention = mentions[0]!;
  if (mention.weak || mention.concepts.length !== 1) return null;
  const concept = mention.concepts[0]!;
  if (concept.type !== "preferred" && concept.type !== "alternative") return null;
  return sameLetters(fact.text, concept.matched) ? concept : null;
}

// ---------------------------------------------------------------- the question

/** What the judge is asked to find in the subject's words, by the kind of concept. */
const ASKS: Record<TagKind, string> = {
  tool: "Used the software",
  "tool-category": "Used this kind of software",
  knowledge: "Knows",
  skill: "Did or can do",
  "skill-group": "Has skills or knowledge in",
  activity: "Did this work",
  occupation: "Worked in the occupation",
};

/** What a question is asked of: a fact's kind and words, or a job's title. */
export type TagQuestionSubject = { kind: "fact"; factKind: string; text: string } | { kind: "role"; title: string };

/**
 * One candidate as a question in the form the judge already answers: is this line supported by
 * this fact? The line says what the tag would say, in a fixed sentence around the concept's
 * preferred label, with the label that was found beside it when the two differ. The one fact is
 * the subject's own words, with what kind of thing they are where that isn't plain. The judge is
 * shown no ID of a fact, a role or a concept.
 */
export function tagQuestion(alias: string, subject: TagQuestionSubject, concept: { kind: TagKind; label: string; matched: string }): JudgeItem {
  const also = normalizeLabel(concept.label) === normalizeLabel(concept.matched) ? "" : ` (also called ${concept.matched})`;
  const said =
    subject.kind === "role"
      ? `Job title: ${subject.title}`
      : subject.factKind === "skill"
        ? `Skill: ${subject.text}`
        : subject.factKind === "credential"
          ? `Credential: ${subject.text}`
          : subject.text;
  return { alias, text: `${ASKS[concept.kind]}: ${concept.label}${also}`, facts: [{ text: said, quote: null }] };
}

// ---------------------------------------------------------------- candidates

/** A concept put forward for one row, from the strongest of its labels found there. */
interface Candidate {
  conceptId: string;
  /** Kind and preferred label as the taxonomy's own record has them. */
  kind: TagKind;
  label: string;
  /** The label that was found, as the taxonomy stores it. */
  matched: string;
  type: LabelType;
  weak: boolean;
  at: number;
}

type Found = Omit<Candidate, "kind" | "label">;

/** Firm before weak, then the label's type, then where it stands in the text, then the concept's ID. */
function stronger(a: Found, b: Found): number {
  return (
    Number(a.weak) - Number(b.weak) ||
    LABEL_TYPES.indexOf(a.type) - LABEL_TYPES.indexOf(b.type) ||
    a.at - b.at ||
    (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0)
  );
}

/** One entry for each concept among the labels found in a row, from its strongest label, strongest first. */
function strongest(mentions: readonly Mention[]): Found[] {
  const best = new Map<string, Found>();
  for (const mention of mentions)
    for (const concept of mention.concepts) {
      const found: Found = { conceptId: concept.id, matched: concept.matched, type: concept.type, weak: mention.weak, at: mention.start };
      const known = best.get(concept.id);
      if (!known || stronger(found, known) < 0) best.set(concept.id, found);
    }
  return [...best.values()].sort(stronger);
}

/**
 * Whether a tag already stored counts for a candidate: made against this run's taxonomy, by the
 * same method and, for the judge, the same model. "own" when the row holds it itself, "other"
 * when only another row with the same words does.
 */
function holds(held: readonly HeldTag[], conceptId: string, method: TagMethod, made: TagMade): "own" | "other" | null {
  const model = method === TAG_RULE_METHOD ? null : made.model;
  let found: "other" | null = null;
  for (const tag of held) {
    if (tag.conceptId !== conceptId || tag.method !== method || tag.model !== model || tag.taxonomyVersion !== made.taxonomyVersion) continue;
    if (tag.own) return "own";
    found = "other";
  }
  return found;
}

type RoleRow = TagSubjects["roles"][number];
type FactRow = TagSubjects["facts"][number];

/** One wording put to the judge once: what it is asked of, the candidate, and every row that takes the answer. */
interface Question {
  subject: TagQuestionSubject;
  candidate: Candidate;
  rows: (RoleRow | FactRow)[];
}

// ---------------------------------------------------------------- one upload

/**
 * Works out the tags for one upload's job roles and facts, and hands each to `keep` as it is
 * decided: the rule's tags and what is carried over for roles, each call's answers about roles,
 * what is carried over for facts, then each call's answers about facts. The first failure ends
 * the run, whether a read, a call, a refused reservation or `keep` itself, and what was kept
 * before it stays kept: a tag stands alone, so nothing is gained by discarding answers already
 * paid for. It never rejects. The report says what was done and, if the run ended early, why.
 */
export async function tagUpload(
  models: Models,
  taxonomy: TagReads,
  subjects: TagSubjects,
  made: TagMade,
  keep: (tags: ProposedTag[]) => Promise<{ stored: number; refused: number }>,
): Promise<TagReport> {
  const report = emptyTagReport();
  try {
    await tag(models, taxonomy, subjects, made, keep, report);
  } catch (error) {
    // A code and nothing else: an error's own words can hold a line, a title or a provider's text.
    report.failed = errorCode(error) ?? "error";
  }
  return report;
}

async function tag(
  models: Models,
  taxonomy: TagReads,
  subjects: TagSubjects,
  made: TagMade,
  keep: (tags: ProposedTag[]) => Promise<{ stored: number; refused: number }>,
  report: TagReport,
): Promise<void> {
  const firstRoles = subjects.roles.slice(0, MAX_TAG_ROLES);
  const firstFacts = subjects.facts.slice(0, MAX_TAG_FACTS);
  report.left.subjects =
    Math.max(subjects.total.roles, subjects.roles.length) - firstRoles.length + Math.max(subjects.total.facts, subjects.facts.length) - firstFacts.length;

  // Every read of the taxonomy comes first, one after another, so a taxonomy that cannot be
  // read ends the run before anything is asked or stored.
  //
  // Labels in each title, then in each fact, in the order the rows were read. The row that would
  // take the words looked through past the cap is left, and so is every row after it: which rows
  // are read never depends on how long a later one happens to be.
  const found = new Map<RoleRow | FactRow, Mention[]>();
  let looked = 0;
  let full = false;
  const within = (text: string): boolean => {
    const count = words(text).length;
    if (full || looked + count > MAX_TAG_WORDS) {
      full = true;
      report.left.words++;
      return false;
    }
    looked += count;
    return true;
  };
  for (const role of firstRoles) {
    if (!within(role.title)) continue;
    found.set(role, await taxonomy.mentions(role.title, { kinds: ROLE_TAG_KINDS }));
    report.roles++;
  }
  for (const fact of firstFacts) {
    if (!within(fact.text)) continue;
    found.set(fact, await taxonomy.mentions(fact.text, { kinds: FACT_TAG_KINDS }));
    report.facts++;
  }
  const roles = firstRoles.filter((role) => found.has(role));
  const facts = firstFacts.filter((fact) => found.has(fact));

  // The rule's last condition. `mentions` was asked only about the kinds that tag a fact, so a
  // label an occupation shares has not been seen yet. The text is looked up among every kind,
  // and the rule stands only if that gives its one concept and no other.
  const ruled = new Set<FactRow>();
  for (const fact of facts) {
    const concept = skillRule(fact, found.get(fact)!);
    if (!concept) continue;
    const carriers = await taxonomy.lookup(fact.text);
    if (carriers.length === 1 && carriers[0]!.id === concept.id) ruled.add(fact);
  }

  // Kind and label come from the taxonomy's own record of each concept, never from a reply. A
  // concept with no record, or of a kind that cannot tag this row, is no candidate.
  const ids = new Set<string>();
  for (const mentions of found.values()) for (const mention of mentions) for (const concept of mention.concepts) ids.add(concept.id);
  const records: Map<string, Concept> = ids.size ? await taxonomy.get([...ids]) : new Map();
  const candidatesOf = (row: RoleRow | FactRow, kinds: readonly TagKind[]): Candidate[] =>
    strongest(found.get(row)!).flatMap((entry) => {
      const record = records.get(entry.conceptId);
      const kind = kinds.find((allowed) => allowed === record?.kind);
      return record && kind ? [{ ...entry, kind, label: record.label }] : [];
    });

  const roleCandidates = roles.map((role) => {
    const all = candidatesOf(role, ROLE_TAG_KINDS);
    report.left.per_role += Math.max(0, all.length - MAX_ROLE_CANDIDATES);
    return { role, kept: all.slice(0, MAX_ROLE_CANDIDATES) };
  });

  // What each occupation usually involves, for the first few a title put forward. It is read for
  // every one of them, decided or not, because the reads come before the answers.
  const usual = new Map<string, Set<string>>();
  const occupations = [...new Set(roleCandidates.flatMap(({ kept }) => kept.map((candidate) => candidate.conceptId)))];
  for (const occupation of occupations.slice(0, MAX_TAG_PROFILES)) {
    const profile = await taxonomy.profile(occupation);
    if (profile) usual.set(occupation, new Set([...profile.skills, ...profile.activities, ...profile.tools].map((item) => item.concept.id)));
  }

  // ---- From here on nothing reads the taxonomy. Tags are decided, and kept as they are.
  const kept = async (tags: ProposedTag[]): Promise<void> => {
    if (tags.length === 0) return;
    const { stored, refused } = await keep(tags);
    report.stored += stored;
    report.refused += refused;
  };
  const proposal = (row: RoleRow | FactRow, candidate: Candidate, method: TagMethod): ProposedTag =>
    "title" in row
      ? { subject: { kind: "role", id: row.id }, words: row.title, conceptId: candidate.conceptId, conceptKind: candidate.kind, label: candidate.label, method }
      : { subject: { kind: "fact", id: row.id }, words: row.text, conceptId: candidate.conceptId, conceptKind: candidate.kind, label: candidate.label, method };

  // One wording is one question, whichever rows say it: the kind of subject, a fact's kind, the
  // words and the concept. Every row with that wording takes the answer.
  let asked = 0;
  const wordings = (): { list: Question[]; add(row: RoleRow | FactRow, candidate: Candidate): void } => {
    const list: Question[] = [];
    const byKey = new Map<string, Question>();
    return {
      list,
      add(row, candidate) {
        const subject: TagQuestionSubject = "title" in row ? { kind: "role", title: row.title } : { kind: "fact", factKind: row.kind, text: row.text };
        const key = JSON.stringify("title" in row ? ["role", null, row.title, candidate.conceptId] : ["fact", row.kind, row.text, candidate.conceptId]);
        const known = byKey.get(key);
        if (known) known.rows.push(row);
        else {
          const question: Question = { subject, candidate, rows: [row] };
          byKey.set(key, question);
          list.push(question);
        }
      },
    };
  };
  /** Puts questions to the judge a call at a time, and keeps each call's tags before the next is sent. */
  const ask = async (questions: Question[], answered: (question: Question) => void = () => {}): Promise<void> => {
    for (let at = 0; at < questions.length; at += QUESTIONS_PER_CALL) {
      const batch = questions.slice(at, at + QUESTIONS_PER_CALL).map((question) => ({ question, item: tagQuestion(`T${++asked}`, question.subject, question.candidate) }));
      const items = batch.map(({ item }) => item);
      report.asked += items.length;
      const out = models.judge ? await models.judge(items) : await models.complete("judge", judgePrompt(items), JudgeOut);
      // This call's answers and no other's: they are read only for the questions this call
      // asked, so one call never answers for another and a reply cannot bring in a concept of
      // its own. Two answers for one question are no answer, whatever either says. The reason
      // given with an answer is not read: a reply contributes one yes or no and nothing else.
      const yes = new Map<string, boolean>();
      for (const verdict of out.verdicts) {
        const id = verdict.id.trim();
        yes.set(id, !yes.has(id) && verdict.verdict === "supported");
      }
      const tags: ProposedTag[] = [];
      for (const { question, item } of batch) {
        if (yes.get(item.alias) !== true) continue;
        report.yes++;
        answered(question);
        for (const row of question.rows) tags.push(proposal(row, question.candidate, TAG_JUDGE_METHOD));
      }
      await kept(tags);
    }
  };

  // The rule's tags first: they cost nothing, and no later failure takes them back.
  const first: ProposedTag[] = [];
  for (const fact of ruled) {
    const [candidate] = candidatesOf(fact, FACT_TAG_KINDS);
    if (!candidate) continue;
    report.candidates++;
    if (holds(fact.held, candidate.conceptId, TAG_RULE_METHOD, made) === "own") report.known++;
    else {
      report.byRule++;
      first.push(proposal(fact, candidate, TAG_RULE_METHOD));
    }
  }

  // Roles before facts, because the occupation decided for a job orders its facts' candidates.
  const decided = new Map<string, Set<string>>();
  const decide = (role: RoleRow, occupation: string) => {
    const known = decided.get(role.id);
    if (known) known.add(occupation);
    else decided.set(role.id, new Set([occupation]));
  };
  const aboutRoles = wordings();
  for (const { role, kept: candidates } of roleCandidates)
    for (const candidate of candidates) {
      report.candidates++;
      const held = holds(role.held, candidate.conceptId, TAG_JUDGE_METHOD, made);
      if (held === "own") {
        report.known++;
        decide(role, candidate.conceptId);
      } else if (held === "other") {
        report.carried++;
        decide(role, candidate.conceptId);
        first.push(proposal(role, candidate, TAG_JUDGE_METHOD));
      } else aboutRoles.add(role, candidate);
    }
  await kept(first);
  // One upload asks only so much, and roles are asked first.
  for (const question of aboutRoles.list.slice(MAX_TAG_QUESTIONS)) report.left.per_upload += question.rows.length;
  const roleQuestions = aboutRoles.list.slice(0, MAX_TAG_QUESTIONS);
  await ask(roleQuestions, (question) => {
    for (const row of question.rows) decide(row as RoleRow, question.candidate.conceptId);
  });

  // A fact's candidates that its job's occupation usually involves come first, then the rest, each
  // in the order above. The cut is made before anything already decided is taken out, so a run
  // that is made again considers the same candidates as the run before it.
  const carried: ProposedTag[] = [];
  const aboutFacts = wordings();
  for (const fact of facts) {
    if (ruled.has(fact)) continue;
    const involved: Set<string>[] = [];
    for (const occupation of fact.roleId === null ? [] : (decided.get(fact.roleId) ?? [])) {
      const profile = usual.get(occupation);
      if (profile) involved.push(profile);
    }
    const likely = (candidate: Candidate) => involved.some((profile) => profile.has(candidate.conceptId));
    const all = candidatesOf(fact, FACT_TAG_KINDS);
    const ordered = involved.length ? [...all.filter(likely), ...all.filter((candidate) => !likely(candidate))] : all;
    report.left.per_fact += Math.max(0, ordered.length - MAX_FACT_CANDIDATES);
    for (const candidate of ordered.slice(0, MAX_FACT_CANDIDATES)) {
      report.candidates++;
      const held = holds(fact.held, candidate.conceptId, TAG_JUDGE_METHOD, made);
      if (held === "own") report.known++;
      else if (held === "other") {
        report.carried++;
        carried.push(proposal(fact, candidate, TAG_JUDGE_METHOD));
      } else aboutFacts.add(fact, candidate);
    }
  }
  await kept(carried);
  // Facts take the questions that roles left.
  const room = MAX_TAG_QUESTIONS - roleQuestions.length;
  for (const question of aboutFacts.list.slice(room)) report.left.per_upload += question.rows.length;
  await ask(aboutFacts.list.slice(0, room));
}
