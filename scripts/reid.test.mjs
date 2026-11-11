import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { employerFiles, fakeAccounts, fakesFor, profileJoin } from "./reid/attackers.mjs";
import { FINE_BANDS, K, RUNGS, WIDE_BANDS, bandOf, describe, keptSkills, popularity, publish, publishUnladdered, view } from "./reid/ladder.mjs";
import { ISCO_08_LEVELS, generatePopulation, structureFrom } from "./reid/population.mjs";

// The re-identification harness, on a made-up population of 20,000 seekers whose structure comes
// from the latest taxonomy build's manifest. It shows the ladder keeps its own rules and reports
// what three attackers manage against it. It claims no pass: the rates describe a synthetic
// population, and the thresholds they would be judged by are the owner's to set
// (docs/visibility-design.md).

const SEED = 20261111;
const SIZE = 20_000;
const SECRET = "reid-test-secret";
const manifest = JSON.parse(readFileSync(new URL("../docs/taxonomy-build-2026-11-11.json", import.meta.url), "utf8"));
const structure = structureFrom(manifest);
const population = generatePopulation({ seed: SEED, size: SIZE, structure });
const { seekers, world } = population;
const published = publish(seekers, { secret: SECRET });
const digest = (value) => createHash("sha256").update(JSON.stringify(value, (_key, inner) => (inner instanceof Map ? [...inner] : inner))).digest("hex");

/** A card for a hand-built test: one occupation, one region, all trusted unless said. */
function card(id, fields = {}) {
  return { id, occupation: 7, unit: 3, minor: 2, subMajor: 1, metro: 11, region: 4, remote: false, months: 30, employer: 1, skills: [1, 2, 3, 4, 5, 6], trusted: true, profile: null, ...fields };
}

test("the population's ISCO levels sum to the manifest's 619 groups, and a wrong sum is refused", () => {
  assert.deepEqual(ISCO_08_LEVELS, { major: 10, subMajor: 43, minor: 130, unit: 436 });
  assert.deepEqual(structure, { levels: ISCO_08_LEVELS, occupations: 3043, skillGroups: 640, toolCategories: 134 });
  const wrong = structuredClone(manifest);
  wrong.inputs.esco.find((input) => input.name === "ISCOGroups_en.csv").rows = 620;
  assert.throws(() => structureFrom(wrong), /ISCO-08's four levels hold 619 groups, and the manifest's ISCOGroups_en.csv has 620/);
  const missing = structuredClone(manifest);
  delete missing.counts.concepts["tool-category"];
  assert.throws(() => structureFrom(missing), /the manifest gives no toolCategories/);
  // The tree the population is drawn on has every level ISCO-08 has, each group with a child.
  for (const [level, count] of [["unit", 436], ["minor", 130], ["subMajor", 43], ["major", 10]])
    assert.equal(new Set(world.occupations.map((occupation) => occupation[level])).size, count, level);
  assert.equal(world.occupations.length, 3043);
  // And every seeker's fields are the shape a card is described by.
  for (const seeker of seekers) {
    assert.ok(seeker.skills.length >= 3 && seeker.skills.length <= 12);
    assert.ok(seeker.months >= 0 && seeker.months <= 540);
    assert.equal(seeker.region, world.metroRegion[seeker.metro]);
    assert.equal(seeker.unit, world.occupations[seeker.occupation].unit);
  }
});

test("the same seed gives the same population and publication", () => {
  const again = generatePopulation({ seed: SEED, size: SIZE, structure });
  assert.equal(digest(again.seekers), digest(seekers));
  assert.equal(digest(publish(again.seekers, { secret: SECRET })), digest(published));
  assert.notEqual(digest(generatePopulation({ seed: SEED + 1, size: SIZE, structure }).seekers), digest(seekers));
});

test("every published card's description is shared by at least k trust-signalled cards, or the card is suppressed", () => {
  const trustedByKey = new Map();
  const seekerById = new Map(seekers.map((seeker) => [seeker.id, seeker]));
  const popular = popularity(seekers);
  for (const [id, entry] of published) {
    if (entry.rung === null) {
      assert.equal(entry.handle, null);
      assert.equal(entry.key, null);
      continue;
    }
    // The key is the card's own description at its rung.
    assert.equal(entry.key, describe(seekerById.get(id), entry.rung, popular));
    if (seekerById.get(id).trusted) trustedByKey.set(entry.key, (trustedByKey.get(entry.key) ?? 0) + 1);
  }
  for (const [id, entry] of published) if (entry.rung !== null) assert.ok((trustedByKey.get(entry.key) ?? 0) >= K, id);
  // A card is placed at the finest rung it can be: its group at every finer rung held fewer than k.
  assert.ok([...published.values()].some((entry) => entry.rung !== null), "some cards are published");
  // A group with fewer than k trusted cards at every rung is suppressed, and untrusted ones don't make up the number.
  const few = [...Array.from({ length: K - 1 }, (_, n) => card(`few-${n}`)), ...Array.from({ length: 5 }, (_, n) => card(`untrusted-${n}`, { trusted: false }))];
  for (const entry of publish(few, { secret: SECRET }).values()) assert.deepEqual(entry, { rung: null, key: null, levelEpoch: 0, handle: null });
  const enough = publish([...few, card("one-more")], { secret: SECRET });
  for (const entry of enough.values()) assert.equal(entry.rung, 0);
});

test("each rung is coarser: parent occupation, region, wider band, fewer skills", () => {
  assert.deepEqual(RUNGS.map((step) => step.skills), [12, 6, 3, 1, 0]);
  assert.deepEqual(RUNGS.map((step) => step.level), ["occupation", "occupation", "unit", "minor", "subMajor"]);
  assert.deepEqual(RUNGS.map((step) => step.place), ["metro", "region", "region", "region", "country"]);
  // The card's band edges, and every fine band inside one wide band.
  assert.deepEqual(FINE_BANDS, [24, 60, 120]);
  assert.deepEqual(WIDE_BANDS, [60]);
  const wideOf = new Map();
  for (let months = 0; months <= 540; months++) {
    const fine = bandOf(months, FINE_BANDS);
    const wide = bandOf(months, WIDE_BANDS);
    assert.equal(wideOf.get(fine) ?? wide, wide, `${months} months`);
    wideOf.set(fine, wide);
  }
  const popular = popularity(seekers);
  for (const seeker of seekers.slice(0, 2000)) {
    for (let rung = 0; rung < RUNGS.length - 1; rung++) {
      const finer = view(seeker, rung, popular);
      const coarser = view(seeker, rung + 1, popular);
      // The occupation, or a group above it.
      const above = { occupation: seeker.occupation, unit: seeker.unit, minor: seeker.minor, subMajor: seeker.subMajor };
      assert.equal(coarser.occupation, above[RUNGS[rung + 1].level]);
      if (RUNGS[rung].level === "unit") assert.equal(world.occupations[seeker.occupation].minor, coarser.occupation);
      // A metro's region, a region, then the country; remote stays remote.
      if (seeker.remote) assert.equal(coarser.place, "remote");
      else if (RUNGS[rung].place === "metro") assert.equal(coarser.place, world.metroRegion[finer.place]);
      // Fewer skills, each one the finer rung showed.
      assert.ok(coarser.skills.length <= finer.skills.length);
      for (const group of coarser.skills) assert.ok(finer.skills.includes(group));
    }
    // Fewer skills keeps the most popular of the card's own.
    const three = keptSkills(seeker, 3, popular);
    for (const group of seeker.skills.filter((other) => !three.includes(other))) for (const kept of three) assert.ok((popular.get(kept) ?? 0) >= (popular.get(group) ?? 0));
  }
});

test("a card that goes from rung 0 to 1 and back to 0 ends with three different handles", () => {
  // Twelve cards alike in everything; ten more in the same region with the same six most popular
  // skills, each different at the finest rung. The common skills are on every card, so they are the
  // most popular.
  const alike = Array.from({ length: 12 }, (_, n) => card(`alike-${n}`, { skills: [1, 2, 3, 4, 5, 6, 100, 101] }));
  const near = Array.from({ length: 10 }, (_, n) => card(`near-${n}`, { metro: 12 + n, skills: [1, 2, 3, 4, 5, 6, 200 + n] }));
  const watched = alike[0].id;
  const first = publish([...alike, ...near], { secret: SECRET });
  assert.equal(first.get(watched).rung, 0);
  // Three of its group leave: nine trusted is fewer than k, so it is placed with the others a rung up.
  const second = publish([...alike.slice(0, 9), ...near], { secret: SECRET, previous: first });
  assert.equal(second.get(watched).rung, 1);
  assert.equal(second.get("near-0").rung, 1);
  // They come back, and so does rung 0.
  const third = publish([...alike, ...near], { secret: SECRET, previous: second });
  assert.equal(third.get(watched).rung, 0);
  const handles = [first, second, third].map((round) => round.get(watched).handle);
  assert.equal(new Set(handles).size, 3, handles.join(" "));
  assert.deepEqual([first, second, third].map((round) => round.get(watched).levelEpoch), [0, 1, 2]);
  // A handle made from the rung alone would have given the first back, and linked the two.
  assert.notEqual(handles[2], handles[0]);
  // Suppressed counts as a level too.
  const gone = publish(alike.slice(0, 3), { secret: SECRET, previous: third });
  assert.deepEqual([gone.get(watched).rung, gone.get(watched).handle, gone.get(watched).levelEpoch], [null, null, 3]);
  const back = publish([...alike, ...near], { secret: SECRET, previous: gone });
  assert.equal(back.get(watched).levelEpoch, 4);
  assert.ok(!handles.includes(back.get(watched).handle));
});

test("an unchanged level keeps its handle, and no handle repeats across cards", () => {
  const again = publish(seekers, { secret: SECRET, previous: published });
  for (const [id, entry] of published) assert.deepEqual(again.get(id), entry, id);
  const handles = [...published.values()].map((entry) => entry.handle).filter((handle) => handle !== null);
  assert.equal(new Set(handles).size, handles.length);
  // The secret is part of every handle.
  const other = publish(seekers, { secret: `${SECRET}-other` });
  for (const [id, entry] of published) if (entry.handle) assert.notEqual(other.get(id).handle, entry.handle);
});

test("fake accounts without trust signals change no count, no popularity and no card's level or handle", () => {
  for (const knowledge of ["insider", "profile"]) {
    const targets = seekers.filter((seeker) => seeker.profile).slice(0, 60);
    const fakes = targets.flatMap((target) => fakesFor(population, target, { knowledge, trusted: false }));
    assert.equal(fakes.length, 60 * (K - 1));
    const padded = [...seekers, ...fakes];
    assert.deepEqual([...popularity(padded)].sort(), [...popularity(seekers)].sort(), knowledge);
    const after = publish(padded, { secret: SECRET, previous: published });
    for (const [id, entry] of published) assert.deepEqual(after.get(id), entry, `${knowledge} ${id}`);
    // So the trusted count behind every published description is what it was.
    const counts = (publication, cards) => {
      const out = new Map();
      for (const one of cards) if (one.trusted && publication.get(one.id).rung !== null) out.set(publication.get(one.id).key, (out.get(publication.get(one.id).key) ?? 0) + 1);
      return out;
    };
    assert.deepEqual(counts(after, padded), counts(published, seekers), knowledge);
    // And the attack that relies on them never succeeds.
    assert.equal(fakeAccounts(population, { knowledge, trusted: false, targets: 50, seed: SEED }).correct, 0);
  }
});

test("reports the attackers' rates", () => {
  const unladdered = publishUnladdered(seekers);
  const rows = [
    ["profile join, laddered", profileJoin(population, published)],
    ["profile join, unladdered", profileJoin(population, unladdered)],
    ["employer files, laddered", employerFiles(population, published)],
    ["employer files, unladdered", employerFiles(population, unladdered)],
  ];
  for (const knowledge of ["insider", "profile"])
    for (const trusted of [false, true]) rows.push([`fake accounts, ${knowledge}, ${trusted ? "trusted" : "untrusted"}`, fakeAccounts(population, { knowledge, trusted, seed: SEED })]);
  for (const [name, outcome] of rows) {
    assert.ok(outcome.rate >= 0 && outcome.rate <= 1, name);
    assert.ok(outcome.correct + outcome.wrong === outcome.guesses && outcome.correct <= outcome.targets, name);
  }
  const placed = [...published.values()].filter((entry) => entry.rung !== null);
  const share = (count) => `${((100 * count) / SIZE).toFixed(1)}%`;
  const lines = [
    `Synthetic population: seed ${SEED}, ${SIZE} seekers, k = ${K}. Published ${placed.length} (${share(placed.length)}), suppressed ${SIZE - placed.length}.`,
    `By rung: ${RUNGS.map((_, rung) => `${rung}: ${placed.filter((entry) => entry.rung === rung).length}`).join(", ")}.`,
    "| Attacker | Targets | Guesses | Right | Wrong | Rate |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(([name, outcome]) => `| ${name} | ${outcome.targets} | ${outcome.guesses} | ${outcome.correct} | ${outcome.wrong} | ${(100 * outcome.rate).toFixed(2)}% |`),
  ];
  console.log(lines.join("\n"));
});
