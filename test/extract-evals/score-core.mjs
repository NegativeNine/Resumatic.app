/** Pure score calculation shared by evaluation and independent promotion verification. */
const rank = { contributed: 1, implemented: 2, led: 3, owned: 4, founded: 5 };
const ratio = (a, b) => (b ? a / b : 1);
const iou = (a, b) => {
  const union = Math.max(a[1], b[1]) - Math.min(a[0], b[0]);
  return union > 0
    ? Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])) / union
    : 0;
};
export function scoreVerified(pred, gold, markdown) {
  if (typeof markdown !== "string") throw new Error("missing_source_for_scoring");
  const roleMap = new Map(),
    usedRoles = new Set(),
    usedPredictedRoles = new Set();
  const normalized = (value) => value.trim().replace(/\s+/g, " ").toLowerCase();
  // Count every known gold date/status, including roles the extractor missed.
  // Otherwise omitting a difficult role can improve the reported accuracy.
  const dateCount = gold.roles.reduce((count, role) =>
    count + Number(role.start !== null) + Number(role.end !== null) +
      Number(role.current === true) + Number(role.unknownEnd === true), 0);
  let dateCorrect = 0,
    correctRoles = 0;
  const rolePairs = [];
  pred.roles.forEach((p, pi) =>
    gold.roles.forEach((g, gi) => {
      const overlap = iou(p.span, g.header);
      if (
        p.kind === g.kind &&
        normalized(p.org) === normalized(g.org) &&
        overlap > 0
      )
        rolePairs.push({ p: pi, g: gi, overlap });
    }),
  );
  rolePairs.sort((a, b) => b.overlap - a.overlap || a.p - b.p || a.g - b.g);
  for (const pair of rolePairs) {
    if (usedPredictedRoles.has(pair.p) || usedRoles.has(pair.g)) continue;
    usedPredictedRoles.add(pair.p);
    usedRoles.add(pair.g);
    const role = pred.roles[pair.p],
      match = gold.roles[pair.g];
    roleMap.set(role.key, match.id);
    let metadataCorrect =
      match.title === null ||
      (role.title !== null &&
        normalized(role.title) === normalized(match.title));
    for (const [observed, expected] of [
      [role.startDate ?? role.unknownEndStartDate ?? null, match.start],
      [role.endDate, match.end],
    ]) {
      // A null gold value does not distinguish unknown from current. Count only
      // dates the reference supplies; precision must not be inferred.
      if (expected !== null) {
        dateCorrect += Number(observed === expected);
        if (observed !== expected) metadataCorrect = false;
      }
    }
    // A null end alone is ambiguous: it can mean unknown or ongoing. Count
    // ongoing status only when the gold explicitly identifies a current role.
    if (match.current === true) {
      const current = role.startDate !== null && role.endDate === null && !role.unknownEndStartDate;
      dateCorrect += Number(current);
      if (!current) metadataCorrect = false;
    }
    if (match.unknownEnd === true) {
      const unknown = role.startDate === null && role.endDate === null && role.unknownEndStartDate === match.start;
      dateCorrect += Number(unknown);
      if (!unknown) metadataCorrect = false;
    }
    if (metadataCorrect) correctRoles++;
  }
  // Skills retain the whole source line as evidence, while the gold span is
  // the individual skill. Compare the literal skill value and its containment
  // in that evidence; IoU against the whole line would mark correct skills wrong.
  const skillMatch = (p, g) =>
    p.kind === "skill" && g.kind === "skill" &&
    p.span[0] <= g.span[0] && p.span[1] >= g.span[1] &&
    normalized(p.text) === normalized(markdown.slice(...g.span)) &&
    normalized(p.text).length > 0;
  const candidates = [];
  pred.facts.forEach((p, pi) =>
    gold.facts.forEach((g, gi) => {
      const overlap = p.kind === "skill" && g.kind === "skill"
        ? Number(skillMatch(p, g))
        : iou(p.span, g.span);
      if (p.kind === g.kind && overlap >= 0.5)
        candidates.push({ p: pi, g: gi, overlap });
    }),
  );
  candidates.sort((a, b) => b.overlap - a.overlap || a.p - b.p || a.g - b.g);
  const correctRole = (pair) => {
    const p = pred.facts[pair.p],
      g = gold.facts[pair.g];
    return (p.roleKey === null ? null : roleMap.get(p.roleKey)) === g.role;
  };
  const spanP = new Set(),
    spanG = new Set();
  let assigned = 0;
  for (const pair of candidates) {
    if (spanP.has(pair.p) || spanG.has(pair.g)) continue;
    spanP.add(pair.p);
    spanG.add(pair.g);
    if (correctRole(pair)) assigned++;
  }
  const matchedP = new Set(),
    matchedG = new Set(),
    levelCheckedP = new Set();
  let correctLevel = 0,
    levelCount = 0,
    inflation = 0,
    matchedSkills = 0;
  for (const pair of candidates) {
    if (!correctRole(pair) || matchedP.has(pair.p) || matchedG.has(pair.g))
      continue;
    matchedP.add(pair.p);
    matchedG.add(pair.g);
    const p = pred.facts[pair.p],
      g = gold.facts[pair.g];
    if (g.kind === "skill") matchedSkills++;
    if (g.level !== null) {
      levelCheckedP.add(pair.p);
      levelCount++;
      correctLevel += Number(p.level === g.level);
      inflation += Number((rank[p.level] ?? 0) > (rank[g.level] ?? 0));
    }
  }
  const covered = gold.facts.filter((g) =>
    pred.facts.some(
      (p) =>
        p.kind === g.kind && (g.kind === "skill"
        ? skillMatch(p, g)
        : Math.max(
          0,
          Math.min(p.span[1], g.span[1]) - Math.max(p.span[0], g.span[0]),
        ) /
          (g.span[1] - g.span[0]) >=
          0.5),
    ),
  ).length;
  const skillProposed = pred.facts.filter((f) => f.kind === "skill").length,
    skillExpected = gold.facts.filter((f) => f.kind === "skill").length;
  const matched = matchedP.size,
    precision = ratio(matched, pred.facts.length),
    recall = ratio(matched, gold.facts.length),
    skillPrecision = ratio(matchedSkills, skillProposed),
    skillRecall = ratio(matchedSkills, skillExpected);
  const trapLeaks = [...pred.roles, ...pred.facts].filter((item) =>
    gold.traps.some((trap) => iou(item.span, trap.span) > 0),
  ).length;
  return {
    precision,
    recall,
    skillPrecision,
    skillRecall,
    skillMatched: matchedSkills,
    skillProposed,
    skillExpected,
    skillsF1: skillPrecision + skillRecall
      ? (2 * skillPrecision * skillRecall) / (skillPrecision + skillRecall)
      : 0,
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    evidenceCoverageRecall: ratio(covered, gold.facts.length),
    roleRecall: ratio(correctRoles, gold.roles.length),
    dateAccuracy: ratio(dateCorrect, dateCount),
    roleMatched: correctRoles,
    roleExpected: gold.roles.length,
    dateCorrect,
    dateCount,
    assignment: ratio(assigned, spanP.size),
    levelAccuracy: ratio(correctLevel, levelCount),
    inflation,
    // Ownership on an unmatched prediction, or one whose gold level is null,
    // needs a separate human verdict; a text-only judge does not assess it.
    unverifiedLevelIndexes: pred.facts.flatMap((f, i) =>
      f.level !== null && !levelCheckedP.has(i) ? [i] : [],
    ),
    trapLeaks,
    reviewCost:
      pred.facts.length -
      matched +
      3 * (gold.facts.length - matched) +
      0.5 * (levelCount - correctLevel),
    matched,
    proposed: pred.facts.length,
    expected: gold.facts.length,
  };
}
