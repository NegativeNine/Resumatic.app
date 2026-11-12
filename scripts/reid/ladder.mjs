// The coarsening ladder: how a card would be published so that its whole description is shared by
// at least k cards that carry trust signals, and how its handle changes. Nothing publishes a card;
// this is the rule the re-identification harness measures. docs/visibility-design.md states it.

import { createHash } from "node:crypto";

/** The fewest trust-signalled cards that must share a published description. */
export const K = 10;
/**
 * Month edges of the fine experience bands: under 2 years, 2 to 5, 5 to 10, 10 or more. They are
 * the card's own (`experienceOf` in src/pipeline/card.ts), and the two change together.
 */
export const FINE_BANDS = Object.freeze([24, 60, 120]);
/** The wide bands: under 5 years, or 5 or more. Each fine band lies inside one. */
export const WIDE_BANDS = Object.freeze([60]);

/**
 * Each rung, finest first: the occupation's level, where, which bands and how many skills. At every
 * rung, a card that says remote says that instead of a place.
 */
export const RUNGS = Object.freeze([
  Object.freeze({ level: "occupation", place: "metro", bands: FINE_BANDS, skills: 12 }),
  Object.freeze({ level: "occupation", place: "region", bands: FINE_BANDS, skills: 6 }),
  Object.freeze({ level: "unit", place: "region", bands: WIDE_BANDS, skills: 3 }),
  Object.freeze({ level: "minor", place: "region", bands: WIDE_BANDS, skills: 1 }),
  Object.freeze({ level: "subMajor", place: "country", bands: null, skills: 0 }),
]);

/** The band a number of months falls in, counted from 0, or null where a rung shows none. */
export function bandOf(months, edges) {
  if (!edges) return null;
  let band = 0;
  while (band < edges.length && months >= edges[band]) band++;
  return band;
}

/** How many trust-signalled cards hold each skill group. Untrusted cards count for nothing. */
export function popularity(cards) {
  const counts = new Map();
  for (const card of cards) if (card.trusted) for (const group of card.skills) counts.set(group, (counts.get(group) ?? 0) + 1);
  return counts;
}

/** A card's own `count` most popular skills, ties to the lower ID, listed by ID. */
export function keptSkills(card, count, popular) {
  return [...card.skills]
    .sort((a, b) => (popular.get(b) ?? 0) - (popular.get(a) ?? 0) || a - b)
    .slice(0, count)
    .sort((a, b) => a - b);
}

/** What a card says at a rung. */
export function view(card, rung, popular) {
  const step = RUNGS[rung];
  return {
    rung,
    occupation: card[step.level],
    place: card.remote ? "remote" : step.place === "country" ? "country" : card[step.place],
    band: bandOf(card.months, step.bands),
    skills: keptSkills(card, step.skills, popular),
  };
}

/** A card's whole description at a rung, as one key. Two cards with the same key cannot be told apart. */
export function describe(card, rung, popular) {
  const seen = view(card, rung, popular);
  return JSON.stringify([seen.rung, seen.occupation, seen.place, seen.band, seen.skills]);
}

function handleOf(secret, id, levelEpoch) {
  return createHash("sha256").update(`${secret}|${id}|${levelEpoch}`).digest("hex").slice(0, 16);
}

/**
 * Places every card at the finest rung where the cards not yet placed that share its exact
 * description include at least `k` trust-signalled ones; a card that fits no rung is suppressed
 * and stays at Notify me. Cards placed at a finer rung are not counted toward a coarser one: they
 * can be told apart, so they are not in its anonymity set.
 *
 * Each card's `levelEpoch` counts how often its rung, suppressed included, has changed since
 * `previous`, and its handle is made from it: a card that goes back to a rung it had before gets a
 * new handle, never its old one. A card in `previous` but not in `cards` (turned off, or away for
 * a while) is kept in the result as not shown, which is a level like suppressed: its epoch moves
 * when it leaves a rung and again when it comes back, so it never returns to its first handle.
 */
export function publish(cards, { k = K, secret, previous } = {}) {
  if (typeof secret !== "string" || !secret) throw new Error("a publication needs a secret");
  const popular = popularity(cards);
  const placed = new Map();
  let unplaced = cards;
  for (let rung = 0; rung < RUNGS.length && unplaced.length; rung++) {
    const groups = new Map();
    for (const card of unplaced) {
      const key = describe(card, rung, popular);
      const group = groups.get(key);
      if (group) group.push(card);
      else groups.set(key, [card]);
    }
    const left = [];
    for (const [key, group] of groups) {
      if (group.filter((card) => card.trusted).length >= k) for (const card of group) placed.set(card.id, { rung, key });
      else left.push(...group);
    }
    unplaced = left;
  }
  const out = new Map();
  for (const card of cards) {
    const { rung, key } = placed.get(card.id) ?? { rung: null, key: null };
    const before = previous?.get(card.id);
    const levelEpoch = before ? before.levelEpoch + (rung !== before.rung ? 1 : 0) : 0;
    out.set(card.id, { rung, key, levelEpoch, handle: rung === null ? null : handleOf(secret, card.id, levelEpoch) });
  }
  for (const [id, before] of previous ?? [])
    if (!out.has(id)) out.set(id, { rung: null, key: null, levelEpoch: before.levelEpoch + (before.rung !== null ? 1 : 0), handle: null });
  return out;
}

/** The baseline with no ladder: every card at its finest description. */
export function publishUnladdered(cards, { secret = "unladdered" } = {}) {
  const popular = popularity(cards);
  return new Map(cards.map((card) => [card.id, { rung: 0, key: describe(card, 0, popular), levelEpoch: 0, handle: handleOf(secret, card.id, 0) }]));
}
