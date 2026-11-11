// The private card: what a recruiter would see of a person if they were ever found, built from
// that person's confirmed tags and shown to them alone. Nothing makes a card visible to anyone
// else, and nothing stores one. docs/visibility-design.md says what a card holds and why, and what
// would have to be true before anyone but its owner saw one.
//
// This file imports nothing, so the Vault, the Worker and the web app can all read it.

/** Skill groups a card shows at most. */
export const MAX_CARD_SKILLS = 12;
/** Skill concepts read for a group, in rank order, before the card stops looking. */
export const MAX_CARD_SKILL_READS = 24;
/** Occupations read, in order, to find the one a card shows. */
export const MAX_CARD_OCCUPATION_CANDIDATES = 8;
/** Broader levels walked, and concepts the walk may read in all. */
export const MAX_CARD_WALK_DEPTH = 12;
export const MAX_CARD_WALK_IDS = 400;
/** The longest taxonomy ID or label a card carries. A concept with a longer one is left off. */
export const MAX_CARD_TEXT_CHARS = 300;

/** Overall experience, in years. The edges are 2, 5 and 10; the top band is open, because years track age. */
export const EXPERIENCE_BANDS = ["under-2", "2-5", "5-10", "10-plus"] as const;
export type ExperienceBand = (typeof EXPERIENCE_BANDS)[number];

/** Said when the preview is asked for where it is switched off. */
export const CARD_PREVIEW_OFF = "The card preview is switched off.";

/** What the Vault gives the Worker to build a card from. Concept IDs, counts and dates only. */
export interface CardMaterial {
  /** Confirmed jobs: dates and the occupations confirmed on them. No organisation, title or row ID. */
  jobs: { startDate: string | null; endDate: string | null; unknownEndStartDate: string | null; occupations: string[] }[];
  /** Concepts confirmed on usable accomplishment or credential facts, most facts first, then ID. */
  skills: { conceptId: string; facts: number }[];
  /**
   * Concepts that any non-shadow tag, in any state, names on a fact marked sensitive or on a part
   * of its division. A card shows none of them: not as a skill, and not as the group another
   * fact's skill is shown as.
   */
  barred: string[];
}

/** A concept as a card shows it: its taxonomy ID and the taxonomy's own label. */
export interface CardConcept {
  id: string;
  label: string;
}

export interface PrivateCard {
  occupation: CardConcept | null;
  /** Null when there is no confirmed job; unknown when the dates can't settle a band. */
  experience: ExperienceBand | "unknown" | null;
  skills: CardConcept[];
}

/** The owner's preview: unavailable where no wholly loaded taxonomy is bound, otherwise their card. */
export type CardPreview = { state: "unavailable" } | { state: "ready"; taxonomyVersion: string; card: PrivateCard };
