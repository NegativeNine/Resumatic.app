// The combined taxonomy as the app reads it: ESCO's skills and occupations and O*NET's occupations,
// work activities and software, in one set of records. The builder (scripts/taxonomy) writes these
// shapes; the Worker reads them from D1. docs/taxonomy.md says where each part comes from.

export const CONCEPT_KINDS = [
  /** ESCO: something a person can do. */
  "skill",
  /** ESCO: something a person knows, including languages and named technologies. */
  "knowledge",
  /** ESCO: a group in the skills or knowledge hierarchy. */
  "skill-group",
  /** An ESCO occupation or an O*NET-SOC occupation. `scheme` says which. */
  "occupation",
  /** An ISCO-08 group, the hierarchy above ESCO's occupations. */
  "occupation-group",
  /** O*NET: a general, intermediate or detailed work activity. */
  "activity",
  /** O*NET: a task statement of one occupation. */
  "task",
  /** O*NET: a named piece of software. */
  "tool",
  /** O*NET: a category of software. */
  "tool-category",
] as const;
export type ConceptKind = (typeof CONCEPT_KINDS)[number];

export type Scheme = "esco" | "onet";

export interface Concept {
  id: string;
  kind: ConceptKind;
  scheme: Scheme;
  /** The source's own code where it has one: an ESCO occupation or group code, an O*NET-SOC code. */
  code: string | null;
  /** The preferred label, exactly as the source gives it. */
  label: string;
  description: string | null;
  meta: ConceptMeta;
}

export interface ConceptMeta {
  /** ESCO: transversal, cross-sector, sector-specific or occupation-specific. */
  reuse?: string;
  /** ESCO: the collections a concept is labelled in, such as "digital" or "green". */
  collections?: string[];
  /** O*NET work activities: general, intermediate or detailed. */
  level?: "general" | "intermediate" | "detailed";
  /** O*NET software: named in job postings across occupations. */
  hot?: boolean;
  /** O*NET tasks: core or supplemental to the occupation. */
  taskType?: string;
  /** ESCO: the ISCO-08 group an occupation sits in. */
  iscoGroup?: string;
  /** ESCO: set only when a concept's status is something other than released. */
  status?: string;
}

export const LABEL_TYPES = [
  "preferred",
  /** A name the source lists as another way to say it, including O*NET's job titles. */
  "alternative",
  /** ESCO's hidden terms: spellings people use that it doesn't show. */
  "hidden",
  /** Made by the builder from a source label by a stated rule. Never the source's own wording. */
  "derived",
] as const;
export type LabelType = (typeof LABEL_TYPES)[number];

export interface Label {
  conceptId: string;
  kind: ConceptKind;
  type: LabelType;
  /** As the source writes it, or as derived. */
  text: string;
  /** In comparison form (normalize.mjs). */
  norm: string;
}

export const RELATIONS = [
  /** From a concept to the one above it in its own hierarchy. */
  "broader",
  /** ESCO: an occupation to a skill or knowledge concept it needs. */
  "essential",
  /** ESCO: an occupation to a skill or knowledge concept it may need. */
  "optional",
  /** ESCO: a skill to another skill it needs. */
  "skill-essential",
  /** ESCO: a skill to another skill it may need. */
  "skill-optional",
  /** O*NET: an occupation to a detailed work activity its tasks carry out. */
  "performs",
  /** O*NET: an occupation to software its people use. */
  "uses",
  /** O*NET: a task to its occupation. */
  "task-of",
  /** O*NET: a task to a detailed work activity it carries out. */
  "task-activity",
  /** The official crosswalk: an O*NET occupation to an ESCO occupation or ISCO group. */
  "matches",
  /** Made by the builder: an O*NET tool and an ESCO concept whose labels compare equal. */
  "same-label",
] as const;
export type Relation = (typeof RELATIONS)[number];

/** How close the crosswalk says two occupations are, strongest first. */
export const MATCH_TYPES = ["exact", "close", "narrow", "broad", "related"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export interface RelationMeta {
  /** `matches`: how close. */
  type?: MatchType;
  /** `performs`: how many of the occupation's tasks carry the activity out. */
  tasks?: number;
  /** `uses`: named in postings for this occupation. */
  inDemand?: boolean;
  /** `uses`: named in postings across occupations. */
  hot?: boolean;
}

export interface Edge {
  src: string;
  rel: Relation;
  dst: string;
  meta: RelationMeta | null;
}

/** What a built taxonomy says about itself. Stored with the data, and stamped on every tag. */
export interface TaxonomyInfo {
  /** The bundle layout. A reader refuses a format it doesn't know. */
  format: 1;
  /** Names the sources and their versions, and ends in the first characters of the content hash. */
  version: string;
  /** SHA-256 of the records, so two builds from the same files can be told to be the same. */
  contentHash: string;
  sources: { id: string; name: string; version: string }[];
}

/** A label found in a stretch of text. */
export interface Mention {
  /** [start, end) in the text as given. */
  start: number;
  end: number;
  /** The words as the text has them. */
  text: string;
  norm: string;
  /** Every concept a label with these words belongs to, strongest label type first. `matched` is that label as stored. */
  concepts: { id: string; kind: ConceptKind; type: LabelType; matched: string }[];
  /**
   * True when the words alone are thin evidence: one short or everyday word that is also a
   * label ("go", "r", "excel"). A weak mention is a candidate to check, never a tag by itself.
   */
  weak: boolean;
}

/** Where an item of an occupation's profile comes from. */
export interface Via {
  /** The occupation whose record carries the item. */
  occupation: string;
  /** Null when that is the occupation asked about; otherwise how the crosswalk relates the two. */
  match: MatchType | null;
}

export interface ProfileItem {
  concept: Concept;
  via: Via;
}

/**
 * One occupation seen through both sources: ESCO's skills and knowledge, O*NET's activities and
 * software, and the occupations the official crosswalk relates it to.
 */
export interface OccupationProfile {
  occupation: Concept;
  counterparts: { concept: Concept; match: MatchType }[];
  skills: (ProfileItem & { need: "essential" | "optional" })[];
  activities: (ProfileItem & { tasks: number })[];
  tools: (ProfileItem & { inDemand: boolean; hot: boolean })[];
}
