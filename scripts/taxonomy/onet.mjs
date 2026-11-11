// Reads the O*NET Database (CSV release) into the combined taxonomy's records: occupations and
// their job titles, work activities, task statements and software. Titles, statements and names
// are kept as O*NET writes them; the one label the builder adds is marked as derived.
//
// Layout: the 30.3 and later CSV release (db_31_0_csv.zip), whose files and columns are those of
// the O*NET 31.0 Data Dictionary. Earlier releases use other file names and are not read.

import { onetElementId, onetOccupationId, onetTaskId, onetToolId } from "../../src/taxonomy/ids.mjs";
import { normalizeLabel } from "../../src/taxonomy/normalize.mjs";
import { readTable } from "./csv.mjs";
import { clean } from "./text.mjs";

export const ONET_REQUIRED = ["occupation_data.csv", "gwas_to_iwas_to_dwas.csv", "tasks_to_dwas.csv", "software_skills.csv"];

const SOC = "O*NET-SOC Code";

/** "Amazon Web Services AWS software" is also written without its last word. Null when it doesn't end so. */
export function withoutSoftware(name) {
  const match = /^(.+?)\s+software$/iu.exec(name);
  const short = match ? match[1].trim() : "";
  return normalizeLabel(short).length >= 2 ? short : null;
}

export function readOnet(files) {
  const concepts = [];
  const labels = [];
  const edges = [];
  const read = [];
  const issues = new Map();
  const issue = (kind) => issues.set(kind, (issues.get(kind) ?? 0) + 1);
  const byLower = new Map(Object.keys(files).map((name) => [name.toLowerCase(), name]));
  // The files repeat a parent on every row beneath it. Such a relation is stated once.
  const stated = new Set();
  const structural = (src, dst) => {
    const key = `${src} ${dst}`;
    if (stated.has(key)) return;
    stated.add(key);
    edges.push({ src, rel: "broader", dst, meta: null });
  };

  const table = (file, required, optional = []) => {
    const name = byLower.get(file);
    if (!name) {
      if (ONET_REQUIRED.includes(file))
        throw new Error(`O*NET database: ${file} is missing. This builder reads the 30.3 and later CSV release.`);
      return null;
    }
    const { records } = readTable(files[name], name, required, optional);
    read.push({ name, rows: records.length });
    return records;
  };

  // Occupations, and the titles people hold in them.
  const occupations = new Set();
  for (const row of table("occupation_data.csv", [SOC, "Title"], ["Description"])) {
    const id = onetOccupationId(row[SOC]);
    const label = clean(row.Title);
    if (!id || !label) { issue("onet_occupation_not_recognised"); continue; }
    if (occupations.has(id)) { issue("onet_occupation_repeated"); continue; }
    occupations.add(id);
    concepts.push({ id, kind: "occupation", scheme: "onet", code: row[SOC], label, description: clean(row.Description ?? "") || null, meta: {} });
    labels.push({ conceptId: id, kind: "occupation", type: "preferred", text: label });
  }
  const occupation = (code) => {
    const id = onetOccupationId(code);
    return id && occupations.has(id) ? id : null;
  };
  for (const row of table("job_titles.csv", [SOC, "Job Title"], ["Short Title"]) ?? []) {
    const id = occupation(row[SOC]);
    if (!id) { issue("onet_title_for_unknown_occupation"); continue; }
    for (const text of [clean(row["Job Title"]), clean(row["Short Title"] ?? "")])
      if (text) labels.push({ conceptId: id, kind: "occupation", type: "alternative", text });
  }

  // Work activities, three levels deep. Each is named once however many rows repeat it.
  const activities = new Map();
  const activity = (element, name, level) => {
    const id = onetElementId("activity", element);
    const label = clean(name);
    if (!id || !label) return null;
    if (!activities.has(id)) {
      activities.set(id, level);
      concepts.push({ id, kind: "activity", scheme: "onet", code: element.trim(), label, description: null, meta: { level } });
      labels.push({ conceptId: id, kind: "activity", type: "preferred", text: label });
    }
    return id;
  };
  for (const row of table("gwas_to_iwas_to_dwas.csv", ["GWA Element ID", "GWA Element Name", "IWA Element ID", "IWA Element Name", "DWA Element ID", "DWA Element Name"])) {
    const general = activity(row["GWA Element ID"], row["GWA Element Name"], "general");
    const intermediate = activity(row["IWA Element ID"], row["IWA Element Name"], "intermediate");
    const detailed = activity(row["DWA Element ID"], row["DWA Element Name"], "detailed");
    if (!general || !intermediate || !detailed) { issue("onet_activity_not_recognised"); continue; }
    structural(detailed, intermediate);
    structural(intermediate, general);
  }

  // Task statements. A task belongs to one occupation and is not a label to look for in text.
  const tasks = new Set();
  const task = (row) => {
    const id = onetTaskId(row["Task ID"]);
    const owner = occupation(row[SOC]);
    const label = clean(row.Task);
    if (!id || !owner || !label) return null;
    if (!tasks.has(id)) {
      tasks.add(id);
      const taskType = clean(row["Task Type"] ?? "");
      concepts.push({ id, kind: "task", scheme: "onet", code: String(row["Task ID"]).trim(), label, description: null, meta: taskType ? { taskType } : {} });
      edges.push({ src: id, rel: "task-of", dst: owner, meta: null });
    }
    return { id, owner };
  };
  for (const row of table("task_statements.csv", [SOC, "Task ID", "Task"], ["Task Type"]) ?? [])
    if (!task(row)) issue("onet_task_not_recognised");
  const performed = new Map();
  for (const row of table("tasks_to_dwas.csv", [SOC, "Task ID", "Task", "DWA Element ID"])) {
    const found = task(row);
    const detailed = onetElementId("activity", row["DWA Element ID"]);
    if (!found || !detailed || !activities.has(detailed)) { issue("onet_task_activity_not_recognised"); continue; }
    const key = `${found.owner} ${detailed}`;
    if (performed.get(key)?.has(found.id)) { issue("onet_task_activity_repeated"); continue; }
    edges.push({ src: found.id, rel: "task-activity", dst: detailed, meta: null });
    performed.set(key, (performed.get(key) ?? new Set()).add(found.id));
  }
  for (const [key, carriedOutBy] of performed) {
    const [src, dst] = key.split(" ");
    edges.push({ src, rel: "performs", dst, meta: { tasks: carriedOutBy.size } });
  }

  // Software. An example has no ID in the database, so its name in comparison form is its ID.
  const tools = new Map();
  const categories = new Set();
  const used = new Map();
  for (const row of table("software_skills.csv", [SOC, "Workplace Example"], ["Element ID", "Element Name", "Hot Technology", "In Demand"])) {
    const owner = occupation(row[SOC]);
    const name = clean(row["Workplace Example"]);
    const id = onetToolId(normalizeLabel(name));
    if (!owner || !id) { issue("onet_software_not_recognised"); continue; }
    const hot = /^y/i.test(row["Hot Technology"] ?? "");
    const inDemand = /^y/i.test(row["In Demand"] ?? "");
    let tool = tools.get(id);
    if (!tool) {
      tool = { id, kind: "tool", scheme: "onet", code: null, label: name, description: null, meta: {} };
      tools.set(id, tool);
      concepts.push(tool);
      labels.push({ conceptId: id, kind: "tool", type: "preferred", text: name });
      const short = withoutSoftware(name);
      if (short) labels.push({ conceptId: id, kind: "tool", type: "derived", text: short });
    } else if (tool.label !== name) labels.push({ conceptId: id, kind: "tool", type: "alternative", text: name });
    if (hot) tool.meta.hot = true;
    const category = onetElementId("toolcat", row["Element ID"] ?? "");
    const categoryName = clean(row["Element Name"] ?? "");
    if (category && categoryName) {
      if (!categories.has(category)) {
        categories.add(category);
        concepts.push({ id: category, kind: "tool-category", scheme: "onet", code: row["Element ID"].trim(), label: categoryName, description: null, meta: {} });
        labels.push({ conceptId: category, kind: "tool-category", type: "preferred", text: categoryName });
      }
      structural(id, category);
    }
    const key = `${owner} ${id}`;
    const before = used.get(key);
    used.set(key, { inDemand: inDemand || before?.inDemand === true, hot: hot || before?.hot === true });
  }
  for (const [key, meta] of used) {
    const [src, dst] = key.split(" ");
    edges.push({ src, rel: "uses", dst, meta });
  }

  return { concepts, labels, edges, files: read, issues: Object.fromEntries([...issues].sort()) };
}
