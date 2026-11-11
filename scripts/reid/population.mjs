// A made-up population of job seekers' cards, for testing how well a card's description keeps its
// owner hidden. Nothing here is real: no person, place or employer, and no card from any vault.
//
// Two things are not made up. The four levels of ISCO-08 are the standard's published structure,
// written out below. The number of occupations and of skill groups and tool categories are read
// from a taxonomy build's manifest, so the made-up population is as fine-grained as the real
// taxonomy a card is built from. Everything else is synthetic and labelled so: which occupation
// sits under which group, the regions, metros and employers, the skills each group's people tend
// to have, and every seeker. docs/visibility-design.md says what the numbers mean.

import { seeded, zipf } from "./random.mjs";

/** ISCO-08's published structure, not read from the manifest. */
export const ISCO_08_LEVELS = Object.freeze({ major: 10, subMajor: 43, minor: 130, unit: 436 });

/** Synthetic: one country of 40 regions and 300 metro areas, and 4,000 employers. */
export const REGIONS = 40;
export const METROS = 300;
export const EMPLOYERS = 4000;
/** Synthetic: how many skill groups and tool categories each ISCO unit group's people draw from. */
export const PROFILE_GROUPS = 25;

/** Synthetic shares and shapes of a seeker's card and public profile. */
export const SHARES = Object.freeze({
  remote: 0.15,
  trusted: 0.85,
  profile: 0.5,
  profileOccupationExact: 0.8,
  profileMetroExact: 0.9,
  profileSkillKept: 0.6,
  profileExtraSkills: 2,
  /** Months of experience: exponential with this mean, capped. */
  monthsMean: 108,
  monthsCap: 540,
  /** Months a public profile is off by: normal with this spread. */
  profileMonthsSd: 12,
  minSkills: 3,
  maxSkills: 12,
});

const rowsOf = (manifest, name) => manifest?.inputs?.esco?.find((input) => input.name === name)?.rows;

/**
 * How fine the population is, from a taxonomy build's manifest: its occupations, and the skill
 * groups and tool categories a card's skills are shown as. Refused unless ISCO-08's four levels add
 * up to the ISCO groups the manifest read, so the levels written here and the build agree.
 */
export function structureFrom(manifest) {
  const levels = { ...ISCO_08_LEVELS };
  const groups = levels.major + levels.subMajor + levels.minor + levels.unit;
  const isco = rowsOf(manifest, "ISCOGroups_en.csv");
  if (isco !== groups) throw new Error(`ISCO-08's four levels hold ${groups} groups, and the manifest's ISCOGroups_en.csv has ${isco}`);
  const occupations = rowsOf(manifest, "occupations_en.csv");
  const skillGroups = manifest?.counts?.concepts?.["skill-group"];
  const toolCategories = manifest?.counts?.concepts?.["tool-category"];
  for (const [name, value] of Object.entries({ occupations, skillGroups, toolCategories }))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`the manifest gives no ${name}`);
  return { levels, occupations, skillGroups, toolCategories };
}

/** Gives every parent at least one child, then the rest at random: `children` indexes into `parents`. */
function assign(random, children, parents) {
  return Array.from({ length: children }, (_, index) => (index < parents ? index : random.int(parents)));
}

/** Draws `count` different indexes by weight. */
function distinct(random, weights, count) {
  const chosen = new Set();
  while (chosen.size < Math.min(count, weights.length)) chosen.add(random.weighted(weights));
  return [...chosen];
}

/** The synthetic world the seekers live in: the ISCO tree's assignments, places, employers and skill profiles. */
function worldFor(random, structure) {
  const { levels } = structure;
  const majorOf = assign(random, levels.subMajor, levels.major);
  const subMajorOf = assign(random, levels.minor, levels.subMajor);
  const minorOf = assign(random, levels.unit, levels.minor);
  const unitOf = assign(random, structure.occupations, levels.unit);
  const occupations = unitOf.map((unit) => {
    const minor = minorOf[unit];
    const subMajor = subMajorOf[minor];
    return { unit, minor, subMajor, major: majorOf[subMajor] };
  });
  const unitOccupations = Array.from({ length: levels.unit }, () => []);
  unitOf.forEach((unit, occupation) => unitOccupations[unit].push(occupation));

  const metroWeights = zipf(METROS, 1);
  const metroRegion = assign(random, METROS, REGIONS);
  // Every metro has an employer; the rest go where people are.
  const employerMetro = Array.from({ length: EMPLOYERS }, (_, index) => (index < METROS ? index : random.weighted(metroWeights)));
  const employerWeights = zipf(EMPLOYERS, 1);
  const metroEmployers = Array.from({ length: METROS }, () => []);
  employerMetro.forEach((metro, employer) => metroEmployers[metro].push(employer));
  const metroEmployerWeights = metroEmployers.map((list) => list.map((employer) => employerWeights[employer]));

  // A card's skills are groups: skill groups and tool categories together, some far more common than others.
  const groups = structure.skillGroups + structure.toolCategories;
  const groupWeights = zipf(groups, 1);
  const unitProfiles = Array.from({ length: levels.unit }, () => distinct(random, groupWeights, PROFILE_GROUPS));
  return { occupations, unitOccupations, metroWeights, metroRegion, employerMetro, metroEmployers, metroEmployerWeights, groups, unitProfiles };
}

const ascending = (a, b) => a - b;

/**
 * A synthetic population of `size` seekers, the same for the same seed and structure. Each has
 * the fields a card is described by, an employer, whether the account carries trust signals, and
 * half of them a public profile that roughly matches their card.
 */
export function generatePopulation({ seed, size, structure }) {
  const random = seeded(seed);
  const world = worldFor(random, structure);
  const occupationWeights = zipf(structure.occupations, 1);
  const profileWeights = zipf(PROFILE_GROUPS, 1);
  const seekers = [];
  for (let index = 0; index < size; index++) {
    const occupation = random.weighted(occupationWeights);
    const { unit, minor, subMajor } = world.occupations[occupation];
    const metro = random.weighted(world.metroWeights);
    const employer = world.metroEmployers[metro][random.weighted(world.metroEmployerWeights[metro])];
    const months = Math.min(SHARES.monthsCap, Math.round(-SHARES.monthsMean * Math.log(1 - random.next())));
    const profileGroups = world.unitProfiles[unit];
    const count = SHARES.minSkills + random.int(SHARES.maxSkills - SHARES.minSkills + 1);
    const skills = distinct(random, profileWeights, count).map((at) => profileGroups[at]).sort(ascending);
    const seeker = {
      id: `s${String(index).padStart(6, "0")}`,
      occupation,
      unit,
      minor,
      subMajor,
      metro,
      region: world.metroRegion[metro],
      remote: random.next() < SHARES.remote,
      months,
      employer,
      skills,
      trusted: random.next() < SHARES.trusted,
      profile: null,
    };
    if (random.next() < SHARES.profile) {
      const siblings = world.unitOccupations[unit].filter((other) => other !== occupation);
      const exactOccupation = random.next() < SHARES.profileOccupationExact || siblings.length === 0;
      const exactMetro = random.next() < SHARES.profileMetroExact;
      let otherMetro = metro;
      while (!exactMetro && otherMetro === metro) otherMetro = random.weighted(world.metroWeights);
      const kept = skills.filter(() => random.next() < SHARES.profileSkillKept);
      const extra = profileGroups.filter((group) => !kept.includes(group));
      for (let added = 0; added < SHARES.profileExtraSkills && extra.length; added++) kept.push(extra.splice(random.int(extra.length), 1)[0]);
      seeker.profile = {
        occupation: exactOccupation ? occupation : random.pick(siblings),
        metro: otherMetro,
        months: Math.max(0, Math.round(months + random.normal(0, SHARES.profileMonthsSd))),
        skills: kept.sort(ascending),
      };
    }
    seekers.push(seeker);
  }
  return { structure, world, seekers };
}
