// The three attackers Gate 3 names, run against a made-up population (population.mjs) published by
// the ladder (ladder.mjs): one who joins cards to public profiles, one who holds an employer's own
// files about its staff, and one who controls fake accounts. Each returns how many it set out to
// find, how many it named, and how many of those were right and wrong. The rates describe the
// made-up population only; docs/visibility-design.md says what they do and don't show.

import { K, RUNGS, bandOf, describe, popularity, publish, view } from "./ladder.mjs";
import { seeded } from "./random.mjs";

/** An occupation at a rung's level: itself, or the ISCO group above it. */
const levelOf = (world, occupation, level) => (level === "occupation" ? occupation : world.occupations[occupation][level]);

/** True when some number of months within `slack` of `months` falls in `band`. */
function reachable(months, slack, edges, band) {
  if (!edges) return true;
  return bandOf(Math.max(0, months - slack), edges) <= band && band <= bandOf(months + slack, edges);
}

/** True when a place someone is known by fits what a card at this rung says. */
function placeFits(world, metro, step, shown) {
  if (shown === "remote" || step.place === "country") return true;
  return step.place === "metro" ? metro === shown : world.metroRegion[metro] === shown;
}

const overlap = (have, shown) => shown.reduce((sum, group) => sum + (have.includes(group) ? 1 : 0), 0);
const result = (targets, guesses, correct, wrong) => ({ targets, guesses, correct, wrong, rate: targets ? correct / targets : 0 });

/**
 * Joins each published card to the public profiles consistent with it at its rung: the occupation
 * at the rung's level, the metro or region, and a band within a year of what the profile says. It
 * names the one profile with the most skills in common, when one stands alone at the top. Rate:
 * right guesses over published cards.
 */
export function profileJoin(population, publication) {
  const { seekers, world } = population;
  const popular = popularity(seekers);
  const index = new Map(RUNGS.map((step) => [step.level, new Map()]));
  for (const seeker of seekers) {
    if (!seeker.profile) continue;
    for (const [level, byValue] of index) {
      const value = levelOf(world, seeker.profile.occupation, level);
      const list = byValue.get(value);
      if (list) list.push(seeker);
      else byValue.set(value, [seeker]);
    }
  }
  let targets = 0;
  let guesses = 0;
  let correct = 0;
  let wrong = 0;
  for (const seeker of seekers) {
    const published = publication.get(seeker.id);
    if (!published || published.rung === null) continue;
    targets++;
    const step = RUNGS[published.rung];
    const shown = view(seeker, published.rung, popular);
    let best = [];
    let top = -1;
    for (const candidate of index.get(step.level).get(shown.occupation) ?? []) {
      const profile = candidate.profile;
      if (!placeFits(world, profile.metro, step, shown.place) || !reachable(profile.months, 12, step.bands, shown.band)) continue;
      const score = overlap(profile.skills, shown.skills);
      if (score > top) {
        top = score;
        best = [candidate];
      } else if (score === top) best.push(candidate);
    }
    if (best.length !== 1) continue;
    guesses++;
    if (best[0].id === seeker.id) correct++;
    else wrong++;
  }
  return result(targets, guesses, correct, wrong);
}

/**
 * The largest employers, each holding its own staff's exact occupation and metro, their months
 * of experience to within six, and four in five of each person's skills. Each employer looks at
 * every published card and singles out one of its staff when exactly one is consistent with it. A
 * shown skill the employer doesn't know of counts against an employee only past half of what the
 * card shows, because the employer knows it is missing some. Rate: right singlings-out over
 * employees with a published card.
 */
export function employerFiles(population, publication, { employers = 5, seed = 1 } = {}) {
  const { seekers, world } = population;
  const random = seeded(seed);
  const popular = popularity(seekers);
  const staff = new Map();
  for (const seeker of seekers) {
    const list = staff.get(seeker.employer);
    if (list) list.push(seeker);
    else staff.set(seeker.employer, [seeker]);
  }
  const largest = [...staff.keys()].sort((a, b) => staff.get(b).length - staff.get(a).length || a - b).slice(0, employers);
  const published = seekers.filter((seeker) => publication.get(seeker.id)?.rung != null);
  let targets = 0;
  let guesses = 0;
  let correct = 0;
  let wrong = 0;
  for (const employer of largest) {
    const files = staff.get(employer).map((person) => ({
      id: person.id,
      occupation: person.occupation,
      metro: person.metro,
      months: Math.max(0, person.months + random.int(13) - 6),
      skills: person.skills.filter(() => random.next() < 0.8),
    }));
    targets += files.filter((file) => publication.get(file.id)?.rung != null).length;
    for (const seeker of published) {
      const rung = publication.get(seeker.id).rung;
      const step = RUNGS[rung];
      const shown = view(seeker, rung, popular);
      const consistent = files.filter(
        (file) =>
          levelOf(world, file.occupation, step.level) === shown.occupation &&
          placeFits(world, file.metro, step, shown.place) &&
          reachable(file.months, 6, step.bands, shown.band) &&
          shown.skills.length - overlap(file.skills, shown.skills) <= Math.floor(shown.skills.length / 2),
      );
      if (consistent.length !== 1) continue;
      guesses++;
      if (consistent[0].id === seeker.id) correct++;
      else wrong++;
    }
  }
  return result(targets, guesses, correct, wrong);
}

/**
 * What an attacker gives `k - 1` fake accounts so they share a target's finest description: the
 * target's own (insider, as a colleague or former employer knows it), or what the target's public
 * profile says (profile). A card holds at most 12 skills, so a fake built from a profile keeps 12.
 */
export function fakesFor(population, target, { knowledge, trusted, k = K, tag = target.id }) {
  const { world } = population;
  let base;
  if (knowledge === "insider") base = target;
  else if (knowledge === "profile" && target.profile) {
    const { occupation, metro, months, skills } = target.profile;
    base = { ...world.occupations[occupation], occupation, metro, region: world.metroRegion[metro], remote: false, months, skills: skills.slice(0, 12) };
  } else throw new Error("fakes are made from an insider's knowledge or from a public profile");
  return Array.from({ length: k - 1 }, (_, index) => ({
    id: `fake-${tag}-${index}`,
    occupation: base.occupation,
    unit: base.unit,
    minor: base.minor,
    subMajor: base.subMajor,
    metro: base.metro,
    region: base.region,
    remote: base.remote,
    months: base.months,
    employer: null,
    skills: [...base.skills],
    trusted,
    profile: null,
    fake: true,
  }));
}

/**
 * For each of `targets` seekers drawn by the seed, separately, adds `k - 1` fake accounts with the
 * target's finest description, by what the attacker knows, and publishes again. It succeeds when
 * the target is placed at the finest rung and every other card sharing that description is a fake:
 * the attacker then knows the one real card there is the target's. Profile mode draws only seekers
 * with a public profile.
 *
 * At the finest rung a card shows all its skills, so its description does not depend on any other
 * card, and whether the target is placed there depends only on the cards that share the target's
 * description or the fakes'. Each run publishes those cards with the fakes; the rest of the
 * population cannot change the outcome. A guess is a lone real card placed beside the fakes.
 */
export function fakeAccounts(population, { targets = 200, trusted, knowledge, seed, k = K, secret = "fake-accounts" }) {
  const { seekers } = population;
  const random = seeded(seed);
  const pool = knowledge === "profile" ? seekers.filter((seeker) => seeker.profile) : [...seekers];
  const chosen = [];
  for (let at = 0; at < Math.min(targets, pool.length); at++) {
    const swap = at + random.int(pool.length - at);
    [pool[at], pool[swap]] = [pool[swap], pool[at]];
    chosen.push(pool[at]);
  }
  const popular = popularity(seekers);
  const finest = new Map();
  for (const seeker of seekers) {
    const key = describe(seeker, 0, popular);
    const group = finest.get(key);
    if (group) group.push(seeker);
    else finest.set(key, [seeker]);
  }
  let guesses = 0;
  let correct = 0;
  let wrong = 0;
  for (const target of chosen) {
    const fakes = fakesFor(population, target, { knowledge, trusted, k });
    const fakeKey = describe(fakes[0], 0, popular);
    const affected = new Set([...(finest.get(fakeKey) ?? []), ...(finest.get(describe(target, 0, popular)) ?? [])]);
    const cards = [...affected, ...fakes];
    const published = publish(cards, { k, secret });
    const placed = published.get(target.id);
    const success = placed.rung === 0 && cards.every((card) => card.id === target.id || card.fake || published.get(card.id).key !== placed.key);
    const beside = [...affected].filter((card) => published.get(card.id).rung === 0 && published.get(card.id).key === published.get(fakes[0].id).key);
    if (published.get(fakes[0].id).rung === 0 && beside.length === 1) {
      guesses++;
      if (beside[0].id === target.id && success) correct++;
      else wrong++;
    }
  }
  return result(chosen.length, guesses, correct, wrong);
}
