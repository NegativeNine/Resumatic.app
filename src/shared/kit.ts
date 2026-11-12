import { APOSTROPHES, UNSEEN, withoutHiddenControls } from "./characters";
import { hasLoneSurrogate } from "./paste";
import type { SharedDocument } from "./sharing";

// Saved answers and the application kit: the types, caps, sentences and pure rules that the web
// app, the routes and the Vault share. A saved answer is the owner's own short answer under a label
// they chose. A kit is what they will send for one job: a resume version, a letter and preparation
// if they want them, and their answers to the employer's questions. Nothing here is ever a fact or
// evidence, and no answer's text is ever sent to a model.
//
// Some questions are never answered from a saved answer: work authorisation, pay, and personal
// details that equal-opportunity forms ask about. A closed list of words and phrases says which.
// It is read strictly on purpose, so it also refuses some innocent questions; those stop and ask.

/** How many saved answers an owner can keep. */
export const MAX_SAVED_ANSWERS = 50;
/** A saved answer's label, once cleaned. */
export const MAX_SAVED_LABEL_CHARS = 80;
/** A saved answer's text, once cleaned. */
export const MAX_SAVED_ANSWER_CHARS = 4_000;
/** The employer's questions in one kit. */
export const MAX_KIT_QUESTIONS = 30;
/** One employer question, once cleaned. */
export const MAX_KIT_QUESTION_CHARS = 1_000;
/** An answer typed for one kit only. */
export const MAX_KIT_ANSWER_CHARS = 4_000;
/**
 * The resume versions a kit offers, newest first, across the job's finished resumes. Each is
 * checked against the gate on every kit read and write, so the list is bounded. A chosen version
 * past it is still shown as chosen and still gated.
 */
export const MAX_KIT_RESUME_CHOICES = 50;
/**
 * The body of a save of a kit's questions, the one kit route that needs more than the usual 64 KiB:
 * 30 questions of 1,000 characters can be three bytes each in UTF-8, before JSON's escapes.
 */
export const MAX_KIT_BODY_BYTES = 256 * 1024;

/** What a question is about when its answer is never saved or matched. */
export type RefusedKind = "work_authorisation" | "pay" | "personal";
/** Why a question in a kit is asked every time: a refused kind, or the judge said it was one. */
export type SensitiveKind = RefusedKind | "judge";

/**
 * The closed list, by kind. Each entry is a word or phrase as `answerKey` writes it: lower case,
 * without apostrophes, single spaces. It matches whole words only. A final `*` stands for the stem
 * with any ending, and `#` for a number. The vocabulary of standard equal-opportunity and
 * work-status forms is here word by word, because each pasted line is a question of its own, so
 * an option line such as "Male" or "Hispanic or Latino" must be refused alone.
 */
export const REFUSED_KIND_WORDS: Readonly<Record<RefusedKind, readonly string[]>> = {
  work_authorisation: [
    "authorisation", "authorization", "authorised to work", "authorized to work", "right to work", "eligible to work",
    "eligibility to work", "entitled to work", "legally able to work", "legally allowed to work", "legally permitted to work",
    "legally entitled to work", "lawfully", "work permit", "work status", "visa", "visas", "sponsor*", "citizen*", "green card",
    "immigration", "residency", "permanent resident", "passport", "h 1b", "h1b", "opt", "stem opt", "cpt", "ead", "tn status",
    "us person", "u s person",
  ],
  pay: [
    "salary", "salaries", "pay", "paid", "compensation", "wage", "wages", "remuneration", "earn", "earns", "earned", "earning",
    "earnings", "income", "bonus*", "stipend", "commission", "commissions", "hourly", "per hour", "per annum", "hourly rate",
    "daily rate", "day rate", "rate of pay", "ote", "ctc", "cost to company", "package", "equity", "stock option", "stock options",
    "rsu", "rsus",
  ],
  personal: [
    // Race and origin.
    "race", "races", "racial", "ethnic*", "national origin", "nationality", "country of origin", "place of birth", "born",
    "birthplace", "native language", "mother tongue", "hispanic", "latino", "latina", "latinx", "latine", "white", "black",
    "african american", "caucasian", "asian", "native american", "american indian", "alaska native", "native hawaiian",
    "pacific islander", "indigenous", "aboriginal", "first nations", "torres strait", "two or more races", "mixed race",
    // Self-identification.
    "self identify", "self identification", "eeo", "eeoc", "ofccp", "equal opportunity", "equal employment", "demographic*",
    "diversity monitoring", "protected class", "protected characteristic", "protected characteristics", "prefer not to say",
    "prefer not to answer", "decline to answer", "decline to state", "do not wish to", "dont wish to",
    // Sex, gender and orientation.
    "gender*", "sex", "sexual*", "transgender", "trans", "cisgender", "intersex", "pronoun", "pronouns", "lgbt*", "male", "female",
    "man", "woman", "men", "women", "non binary", "nonbinary", "genderqueer", "gay", "lesbian", "bisexual", "heterosexual",
    "homosexual", "queer", "asexual",
    // Age.
    "age", "aged", "how old", "years old", "years of age", "date of birth", "birth date", "birthdate", "birthday", "dob",
    "over #", "under #", "older than #", "younger than #",
    // Religion.
    "religio*", "faith", "caste", "christian", "muslim", "jewish", "hindu", "sikh", "buddhist", "atheist",
    // Disability and health.
    "disab*", "handicap*", "health", "medical", "illness", "impairment", "neurodivergent", "neurodiverse", "autis*", "adhd",
    "dyslexi*", "vaccin*", "covid", "drug test", "drug screen", "accommodation", "accommodations", "reasonable adjustment",
    "reasonable adjustments",
    // Veteran status.
    "veteran*", "military", "armed forces", "national service",
    // Criminal record.
    "criminal", "convict*", "conviction", "convictions", "felon*", "arrest*", "offence", "offences", "offense", "offenses",
    "background check", "dbs", "police check",
    // Marital and family status.
    "marital", "married", "spouse", "husband", "wife", "maiden name", "civil partner*", "domestic partner", "partner status",
    "divorced", "widow*", "child", "children", "kids", "childcare", "dependant", "dependants", "dependent", "dependents",
    "family status", "caregiver", "carer", "caring responsibilities",
    // Pregnancy and leave.
    "pregnan*", "maternity", "paternity", "parental leave",
  ],
};

const REFUSED_KINDS = ["work_authorisation", "pay", "personal"] as const satisfies readonly RefusedKind[];

/** One entry as a pattern over a key: whole words between spaces, the key's ends counting as spaces. */
function entryPattern(entry: string): RegExp {
  const words = entry.split(" ").map((word) =>
    word === "#" ? "\\p{N}+" : word.endsWith("*") ? `${word.slice(0, -1)}[\\p{L}\\p{N}]*` : word,
  );
  return new RegExp(`(?<![^ ])${words.join(" ")}(?![^ ])`, "u");
}

const PATTERNS: readonly [RefusedKind, readonly RegExp[]][] = REFUSED_KINDS.map((kind) => [kind, REFUSED_KIND_WORDS[kind].map(entryPattern)]);

/**
 * The words of a label or question as they are compared: the same letters whatever their form,
 * apostrophes taken out, lower case, and every run of anything that isn't a letter or a digit one
 * space. Characters that are not shown go first, so one can't split a word in two.
 */
export function answerKey(text: string): string {
  return text
    .replace(UNSEEN, "")
    .normalize("NFKC")
    .replace(APOSTROPHES, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The first kind on the closed list that this text is about, or null. */
export function refusedKind(text: string): RefusedKind | null {
  const key = answerKey(text);
  if (!key) return null;
  for (const [kind, patterns] of PATTERNS) if (patterns.some((pattern) => pattern.test(key))) return kind;
  return null;
}

/** An employer's question as it is stored: one line, with nothing hidden, trimmed. */
export function cleanQuestion(text: string): string {
  return withoutHiddenControls(text).replace(UNSEEN, "").replace(/\s+/g, " ").trim();
}

/** A label as it is stored: one line, as a question is. */
export function cleanLabel(text: string): string {
  return cleanQuestion(text);
}

/** An answer as it is stored: every line ending a newline, nothing hidden, trimmed. Lines are kept. */
export function cleanSavedAnswer(text: string): string {
  return withoutHiddenControls(text.replace(/\r\n|[\r\u2028\u2029]/g, "\n")).replace(UNSEEN, "").trim();
}

/** An answer typed for one kit, cleaned as a saved answer is. */
export function cleanTypedAnswer(text: string): string {
  return cleanSavedAnswer(text);
}

/** Said when a label has nothing to compare; null when it can be saved. */
export function savedLabelError(label: string): string | null {
  return answerKey(label) === "" ? SAVED_ANSWER_LABEL_EMPTY : null;
}

/** A saved answer's label and text, cleaned, or null when either is the wrong type, empty or over its cap. */
export function cleanSavedAnswerInput(input: unknown): SavedAnswerInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const { label, answer } = input as Record<string, unknown>;
  if (typeof label !== "string" || typeof answer !== "string" || hasLoneSurrogate(label) || hasLoneSurrogate(answer)) return null;
  const cleaned = { label: cleanLabel(label), answer: cleanSavedAnswer(answer) };
  if (cleaned.label.length < 1 || cleaned.label.length > MAX_SAVED_LABEL_CHARS) return null;
  if (cleaned.answer.length < 1 || cleaned.answer.length > MAX_SAVED_ANSWER_CHARS) return null;
  return cleaned;
}

/** A typed answer, cleaned, or null when it is the wrong type, empty or over its cap. */
export function cleanKitAnswer(answer: unknown): string | null {
  if (typeof answer !== "string" || hasLoneSurrogate(answer)) return null;
  const cleaned = cleanTypedAnswer(answer);
  return cleaned.length >= 1 && cleaned.length <= MAX_KIT_ANSWER_CHARS ? cleaned : null;
}

/**
 * A kit's questions as a save sends them, each cleaned, or null when the list is too long, a text
 * is empty or too long once cleaned, or an ID is malformed or repeated. Whether each ID is in the
 * kit is the Vault's to say.
 */
export function cleanKitQuestions(input: unknown): { id: string | null; text: string }[] | null {
  if (!Array.isArray(input) || input.length > MAX_KIT_QUESTIONS) return null;
  const ids = new Set<string>();
  const cleaned: { id: string | null; text: string }[] = [];
  // By index, so a gap in the array is read as the missing value it is.
  for (let index = 0; index < input.length; index++) {
    const item: unknown = input[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const { id, text, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || typeof text !== "string" || hasLoneSurrogate(text)) return null;
    if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id))) return null;
    const question = cleanQuestion(text);
    if (question.length < 1 || question.length > MAX_KIT_QUESTION_CHARS) return null;
    if (typeof id === "string") ids.add(id);
    cleaned.push({ id: typeof id === "string" ? id : null, text: question });
  }
  return cleaned;
}

/** A chosen part: an ID and a version, or null for none. Undefined when it can't be read. */
function cleanPart(value: unknown): KitPart | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const { id, version, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return undefined;
  return { id, version };
}

/** The three choices of a kit, or null when any can't be read. */
export function cleanKitParts(input: unknown): Omit<KitPartsUpdate, "expectedRevision"> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const { resume, letter, prep } = input as Record<string, unknown>;
  const parts = { resume: cleanPart(resume), letter: cleanPart(letter), prep: cleanPart(prep) };
  if (parts.resume === undefined || parts.letter === undefined || parts.prep === undefined) return null;
  return parts as Omit<KitPartsUpdate, "expectedRevision">;
}

/** An answer change as it is applied, or null when it can't be read. Typed text is cleaned and capped by the Vault. */
export function readKitAnswerChange(input: unknown): KitAnswerChange | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const change = input as Record<string, unknown>;
  const keys = Object.keys(change).sort().join(",");
  switch (change.kind) {
    case "confirm":
    case "reject":
      return keys === "kind" ? { kind: change.kind } : null;
    case "use":
      return keys === "kind,savedAnswerId" && typeof change.savedAnswerId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(change.savedAnswerId)
        ? { kind: "use", savedAnswerId: change.savedAnswerId }
        : null;
    case "type":
      return keys === "answer,kind" && typeof change.answer === "string" ? { kind: "type", answer: change.answer } : null;
    case "save":
      return keys === "answer,kind,label" && typeof change.label === "string" && typeof change.answer === "string"
        ? { kind: "save", label: change.label, answer: change.answer }
        : null;
    default:
      return null;
  }
}

/** A saved answer a question may be matched to: one whose label and text today's list takes. */
export interface UsableSaved {
  id: string;
  labelKey: string;
}

/**
 * The deterministic part of matching, in order: a question on the closed list is sensitive, and a
 * question whose key is a usable label's key is matched to it. Null leaves it unsettled.
 */
export function classifyDeterministic(
  text: string,
  usable: readonly UsableSaved[],
): { state: "sensitive"; kind: RefusedKind } | { state: "matched"; savedAnswerId: string } | null {
  const kind = refusedKind(text);
  if (kind) return { state: "sensitive", kind };
  const key = answerKey(text);
  const found = key ? usable.find((saved) => saved.labelKey === key) : undefined;
  return found ? { state: "matched", savedAnswerId: found.id } : null;
}

// ---------------------------------------------------------------- the contract

export interface SavedAnswerInput {
  label: string;
  answer: string;
}

export interface SavedAnswer {
  id: string;
  /** 1 when made; one more with every edit. */
  revision: number;
  label: string;
  answer: string;
  /** The kind today's list refuses its label or text for. Such an answer is never matched or used. */
  refusedKind: RefusedKind | null;
  createdAt: number;
  updatedAt: number;
}

export interface KitPart {
  id: string;
  version: number;
}

export type KitQuestionState = "matched" | "asks" | "sensitive";
export type KitMatchedBy = "label" | "judge" | "owner";

export interface KitQuestionView {
  id: string;
  position: number;
  /** The employer's question, cleaned: untrusted text, shown as text. */
  text: string;
  state: KitQuestionState;
  /** How a matched question was matched; null otherwise. */
  matchedBy: KitMatchedBy | null;
  /** The saved answer a matched question points at, as it is now. */
  savedAnswer: SavedAnswer | null;
  /** A matched question's owner has checked the saved answer as it is now. */
  confirmed: boolean;
  /** Why a sensitive question is asked every time. */
  sensitiveKind: SensitiveKind | null;
  /** An answer typed for this kit only. */
  typedAnswer: string | null;
}

export type KitProblemCode = "no_resume" | "resume_refused" | "letter_refused" | "prep_refused" | "refused_kind" | "unanswered";

/** One reason a kit can't be approved or downloaded now, with the questions it is about. */
export interface KitProblem {
  code: KitProblemCode;
  questionIds?: string[];
}

export interface KitChoice extends KitPart {
  createdAt: number;
}

export interface KitView {
  applicationId: string;
  /** 0 until the first write to the kit. */
  revision: number;
  state: "draft" | "approved";
  approvedAt: number | null;
  resume: KitPart | null;
  letter: KitPart | null;
  prep: KitPart | null;
  questions: KitQuestionView[];
  /** What can go in this kit now, newest first. */
  choices: { resumes: KitChoice[]; letters: KitChoice[]; preps: KitChoice[] };
  /** Worked out on every read, in order. Empty when every check passes. */
  problems: KitProblem[];
  /** Approved, with no problem: it can be downloaded. */
  ready: boolean;
  updatedAt: number | null;
}

export type KitAnswerChange =
  | { kind: "confirm" }
  | { kind: "reject" }
  | { kind: "use"; savedAnswerId: string }
  | { kind: "type"; answer: string }
  | { kind: "save"; label: string; answer: string };

export interface KitQuestionsUpdate {
  /** In order. A question with an `id` is one already in the kit; one without is new. */
  questions: { id?: string; text: string }[];
  expectedRevision: number;
}

export interface KitPartsUpdate {
  resume: KitPart | null;
  letter: KitPart | null;
  prep: KitPart | null;
  expectedRevision: number;
}

/**
 * Everything an approved kit's ZIP is made from, read in one turn. `Render` is the resume's
 * RenderData (src/shared/types.ts), named by the Vault and the routes: the web app, which never
 * reads this, doesn't build the Worker's types.
 */
export interface KitArchiveData<Render = unknown> {
  revision: number;
  approvedAt: number;
  job: { title: string | null; company: string | null };
  resume: { id: string; render: Render };
  letter: SharedDocument | null;
  prep: SharedDocument | null;
  /** In order. A matched question's answer is its saved answer's text as it is now. */
  answers: { question: string; answer: string }[];
}

/** The three tables in the owner's export, each row as stored, revisions included. */
export interface KitExport {
  savedAnswers: { id: string; revision: number; label: string; labelKey: string; answer: string; createdAt: number; updatedAt: number }[];
  applicationKits: {
    applicationId: string;
    revision: number;
    state: "draft" | "approved";
    approvedAt: number | null;
    resume: KitPart | null;
    letter: KitPart | null;
    prep: KitPart | null;
    createdAt: number;
    updatedAt: number;
  }[];
  kitQuestions: {
    id: string;
    applicationId: string;
    position: number;
    question: string;
    state: KitQuestionState;
    matchedBy: KitMatchedBy | null;
    savedAnswerId: string | null;
    confirmedRevision: number | null;
    sensitiveKind: SensitiveKind | null;
    typedAnswer: string | null;
  }[];
}

/** A kit as the Vault reads it from its store. */
export type KitRecord = KitExport["applicationKits"][number];
/** A kit's question as the Vault reads it from its store. */
export type KitQuestionRecord = KitExport["kitQuestions"][number];

// ---------------------------------------------------------------- sentences
// Each is shown to the person as it stands. The apostrophes are straight, as in every sentence the
// server sends, and the web app curls them.

export const SAVED_ANSWER_REFUSED =
  "This saved answer couldn't be saved as written. Give it a label of up to 80 characters and an answer of up to 4,000, then save again.";
export const SAVED_ANSWER_LABEL_EMPTY = "Give this saved answer a label with at least one letter or number, then save again.";
export const SAVED_ANSWER_LABEL_TAKEN = "You already have a saved answer with this label. Change that one, or choose another label.";
export const SAVED_ANSWERS_FULL = "You can keep up to 50 saved answers. Delete one you no longer use, then add this one.";
export const SAVED_ANSWER_CHANGED = "This saved answer was changed somewhere else. Load your saved answers, check it, then save again.";
/** Said when a saved answer's label or text is about a refused kind. */
export const REFUSED_KIND_SENTENCE: Readonly<Record<RefusedKind, string>> = {
  work_authorisation:
    "Saved answers can't hold work authorisation, visas, sponsorship or citizenship. These questions are asked every time you apply, and their answers are never saved.",
  pay: "Saved answers can't hold salary, pay or compensation. These questions are asked every time you apply, and their answers are never saved.",
  personal:
    "Saved answers can't hold personal details such as race, ethnicity, national origin, gender, sexual orientation, age, religion, disability, health, veteran status, criminal record, marital or family status, or pregnancy. These questions are asked every time you apply, and their answers are never saved.",
};
/** What each kind is about, as the interface names it in "This question asks about …". */
export const SENSITIVE_KIND_WORDS: Readonly<Record<SensitiveKind, string>> = {
  work_authorisation: "work authorisation, visas, sponsorship or citizenship",
  pay: "salary, pay or compensation",
  personal:
    "personal details such as race, ethnicity, national origin, gender, sexual orientation, age, religion, disability, health, veteran status, criminal record, marital or family status, or pregnancy",
  judge: "something answers are never saved for: work authorisation, pay or personal details",
};

export const KIT_CHANGED = "This application kit was changed somewhere else. Load it again, check it, then try again.";
export const KIT_QUESTIONS_REFUSED =
  "These questions couldn't be saved as written. Keep to 30 questions of up to 1,000 characters each, then save again.";
export const KIT_ANSWER_REFUSED = "This answer couldn't be saved as written. Keep it to 4,000 characters, then save again.";
export const KIT_CHOICE_REFUSED = "Choose a finished resume, cover letter or interview preparation made for this job.";
export const KIT_RESUME_REFUSED =
  "This resume version can't go in a kit: it uses a fact you've marked sensitive, or a line its facts don't back. Choose another version.";
export const KIT_DOCUMENT_REFUSED = "This document can't go in a kit as it is. Make it again, then choose the new one.";
export const KIT_NO_RESUME = "Choose a resume for this kit before approving it.";
export const KIT_UNANSWERED = "Every question needs an answer you've typed or checked before the kit can be approved.";
export const KIT_SENSITIVE_NEVER_SAVED = "This question asks about something whose answer is never saved. Type your answer for this application only.";
export const KIT_NOT_APPROVED = "Approve this application kit before downloading it.";
export const KIT_CHANGED_WHILE_PREPARING = "This application kit changed while it was being prepared. Check it, then download it again.";

/** Each problem's sentence, and the code it is refused with at approval and download. */
export const KIT_PROBLEMS: Readonly<Record<KitProblemCode, { code: "invalid" | "conflict"; sentence: string }>> = {
  no_resume: { code: "invalid", sentence: KIT_NO_RESUME },
  resume_refused: { code: "conflict", sentence: KIT_RESUME_REFUSED },
  letter_refused: { code: "conflict", sentence: KIT_DOCUMENT_REFUSED },
  prep_refused: { code: "conflict", sentence: KIT_DOCUMENT_REFUSED },
  refused_kind: { code: "invalid", sentence: KIT_SENSITIVE_NEVER_SAVED },
  unanswered: { code: "invalid", sentence: KIT_UNANSWERED },
};
