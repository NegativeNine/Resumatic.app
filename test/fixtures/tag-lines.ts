import type { FactKind } from "../../src/shared/api";

// Labelled examples for tagging facts and job roles with taxonomy concepts. Every line and title
// here is made up, and so is the taxonomy they are read against (test/fixtures/taxonomy): the
// concept IDs below are that taxonomy's. The examples exercise the candidates, the rule and the
// question, and say what each is for. They cannot set a threshold: how often a proposed tag is
// wrong has to be measured, for each method, on lines given with consent
// (docs/taxonomy-pipelines-design.md, "What must be measured before anything is shown").

const skill = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const occupation = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The concepts of the made-up taxonomy that the examples name. */
export const TAG_CONCEPTS = {
  /** ESCO skill "manage budgets", also "budget management". */
  manageBudgets: skill(1),
  /** ESCO skill "lead a team". */
  leadATeam: skill(2),
  /** ESCO knowledge "Python (computer programming)", also "Python" and the hidden term "python3". */
  pythonKnowledge: skill(3),
  /** ESCO knowledge "container orchestration", also "Kubernetes" and "K8s". */
  containerOrchestration: skill(4),
  /** ESCO knowledge "Go (computer programming)", also "Golang" and, made by the builder, "Go". */
  goKnowledge: skill(6),
  /** ESCO knowledge "SQL". */
  sql: skill(8),
  /** ESCO knowledge group "information and communication technologies". */
  ict: "esco:isced-f:061",
  /** O*NET software. */
  python: "onet:tool:python",
  go: "onet:tool:go",
  kubernetes: "onet:tool:kubernetes",
  cpp: "onet:tool:c++",
  excel: "onet:tool:microsoft-excel",
  /** O*NET software "Amazon Web Services AWS software"; the builder's shortened label drops the last word. */
  aws: "onet:tool:amazon-web-services-aws-software",
  /** O*NET software category "Container orchestration software". */
  orchestrationSoftware: "onet:toolcat:5.A.1.02",
  /** O*NET detailed work activity "Manage project teams." */
  manageProjectTeams: "onet:activity:4.A.4.b.4.I01.D01",
  /** O*NET intermediate work activity "Manage budgets or finances." */
  manageBudgetsOrFinances: "onet:activity:4.A.4.c.3.I01",
  /** ESCO occupation "software developer", also "software engineer" and "programmer". */
  softwareDeveloper: occupation(1),
  /** ESCO occupation "ICT project manager", also "IT project manager". */
  ictProjectManager: occupation(2),
  /** ESCO occupation "budget analyst". */
  budgetAnalyst: occupation(3),
  /** O*NET occupation "Example Software Developers", with the job title "Software Engineer". */
  softwareDevelopers: "onet:occ:99-1001.00",
  /** O*NET occupation "Example Budget Analysts". */
  budgetAnalysts: "onet:occ:99-1003.00",
  /** O*NET occupation "Example Project Management Specialists", with the job title "Tech PM". */
  projectSpecialists: "onet:occ:99-1002.00",
  /** ISCO group "Software developers": a group of occupations, never a job's occupation. */
  developersGroup: "esco:isco:C2512",
} as const;

export interface LabelledCandidate {
  /** The concept's ID in the made-up taxonomy. */
  concept: string;
  /** What a careful reader would say: the words show the concept ("tag"), or they do not ("none"). */
  expect: "tag" | "none";
  /**
   * What settles it. "rule": the rule for a listed skill tags it, with no model. "judge": it is
   * put to the judge; where a reader expects none, nothing but the judge's answer stops the tag.
   * "vector": it is near the words in the vector index, and no label in them names it, so it is
   * put to the judge in the same question; again only the judge's answer stops a wrong one.
   * "check": something that needs no model keeps it from ever being a candidate, whatever a
   * judge would say.
   */
  decidedBy: "rule" | "judge" | "vector" | "check";
  why: string;
}

/** A fact with the line it was read from, or a job's title, and every concept worth a word about it. */
export type TagExample =
  | { fact: { kind: FactKind; text: string; quote: string }; candidates: LabelledCandidate[] }
  | { title: string; candidates: LabelledCandidate[] };

const C = TAG_CONCEPTS;
const LIST = "Skills: Go, SQL, C++, Microsoft Excel";
const NAMES = "Golang | Python (computer programming) | Container Orchestration | Kubernetes";
const LOWER = "Skills: sql, python3";
const line = (text: string, ...candidates: LabelledCandidate[]): TagExample => ({ fact: { kind: "accomplishment", text, quote: text }, candidates });
const listed = (quote: string, text: string, ...candidates: LabelledCandidate[]): TagExample => ({ fact: { kind: "skill", text, quote }, candidates });
const title = (text: string, ...candidates: LabelledCandidate[]): TagExample => ({ title: text, candidates });
const by = (decidedBy: LabelledCandidate["decidedBy"], expect: LabelledCandidate["expect"]) => (concept: string, why: string): LabelledCandidate => ({ concept, expect, decidedBy, why });
const rule = by("rule", "tag");
const yes = by("judge", "tag");
const no = by("judge", "none");
const never = by("check", "none");
const near = by("vector", "tag");
const notNear = by("vector", "none");

export const TAG_LINES: TagExample[] = [
  // ---- skills from a list: the rule tags an item that is one label and nothing else
  listed(LIST, "SQL", rule(C.sql, "the list's own item is the label itself")),
  listed(LIST, "C++", rule(C.cpp, "the label, marks and all")),
  listed(LIST, "Microsoft Excel", rule(C.excel, "two words, and both are the label's")),
  listed(LIST, "Go", yes(C.go, "two letters are thin evidence, so it is asked about"), yes(C.goKnowledge, "the same two letters, under a label the builder made")),
  listed(NAMES, "Golang", rule(C.goKnowledge, "another name the source lists for the concept")),
  listed(NAMES, "Python (computer programming)", rule(C.pythonKnowledge, "the label whole, brackets and all")),
  listed(NAMES, "Container Orchestration", rule(C.containerOrchestration, "the label in other letter case")),
  listed(NAMES, "Kubernetes", yes(C.kubernetes, "one name that two concepts carry: the software"), yes(C.containerOrchestration, "and the knowledge of it")),
  // ---- skills the rule must leave to the judge
  listed(LOWER, "SQL", yes(C.sql, "the upload wrote it in lower case, and the text is the reading model's spelling")),
  listed(LOWER, "python3", yes(C.pythonKnowledge, "a spelling the source keeps and does not show")),
  listed("Skills: Go ✓, SQL ✗", "SQL ✗", no(C.sql, "the list marks it as not held")),
  listed("Skills: Golang, SQL?", "SQL?", no(C.sql, "the question mark is the writer's own doubt")),
  listed("Microsoft ✗ Excel, Golang", "Microsoft ✗ Excel", no(C.excel, "a mark inside the name, and what it says of the skill is not plain")),
  listed("Microsoft-Excel, Golang", "Microsoft-Excel", yes(C.excel, "a hyphen for the space: the same name, but not the label's own letters")),
  listed("Languages: Python (advanced), Golang", "Python (advanced)", yes(C.python, "a word beside the label, and two concepts carry the name"), yes(C.pythonKnowledge, "the same")),
  listed("Cloud: Amazon Web Services AWS, Golang", "Amazon Web Services AWS", yes(C.aws, "a label the builder shortened from the source's own")),
  { fact: { kind: "credential", text: "SQL", quote: "Name: SQL" }, candidates: [yes(C.sql, "the rule is for listed skills; a credential names a course or an award")] },
  // ---- lines
  line("Led the migration of 40 services to Kubernetes", yes(C.kubernetes, "the line says it was used"), yes(C.containerOrchestration, "and shows the knowledge")),
  line("Used Python and Microsoft Excel to build weekly reports", yes(C.python, "used"), yes(C.pythonKnowledge, "and so known"), yes(C.excel, "used")),
  line("Budget management for a team of 12 across two sites", yes(C.manageBudgets, "another name the source lists for the skill")),
  line("Manage project teams across two offices", yes(C.manageProjectTeams, "the activity in its own words")),
  line("Taught information and communication technologies to adult learners", yes(C.ict, "a field of knowledge, named whole")),
  line("Never used Kubernetes in production", no(C.kubernetes, "the line denies it"), no(C.containerOrchestration, "the line denies it")),
  line("Planning to learn Python next year", no(C.python, "an intention, not experience"), no(C.pythonKnowledge, "an intention, not experience")),
  line("Hired and onboarded two Python developers", no(C.python, "the line only mentions it: the skill is someone else's"), no(C.pythonKnowledge, "the same")),
  line("Asked to lead a team of five, and turned it down", no(C.leadATeam, "the line says it did not happen")),
  line(
    "Selected container orchestration software for the platform team",
    no(C.orchestrationSoftware, "choosing software is not using it"),
    notNear(C.containerOrchestration, "nor is it knowing the field, though the words are near it"),
  ),
  line("Go to market planning for two product launches", no(C.go, "an everyday word that is also a name"), no(C.goKnowledge, "the same")),
  line("Reported to the IT project manager", never(C.ictProjectManager, "an occupation named in a line is usually someone else's, so a fact is never tagged with one")),
  line("Moved session data to NoSQL stores", never(C.sql, "NoSQL names something else, and a label is never found inside a longer word")),
  // ---- job titles
  title("Senior Software Engineer", yes(C.softwareDeveloper, "a name ESCO lists for the occupation"), yes(C.softwareDevelopers, "and a job title O*NET lists for its own")),
  title("IT Project Manager", yes(C.ictProjectManager, "a name the source lists for the occupation")),
  title("Programmer", yes(C.softwareDeveloper, "one word, written as the source writes it")),
  title("Tech PM", yes(C.projectSpecialists, "a short job title O*NET lists")),
  title("Budget Analyst", yes(C.budgetAnalyst, "the occupation's own name"), near(C.budgetAnalysts, "and O*NET's, by a name its words are near")),
  title(
    "Assistant to the Budget Analyst",
    no(C.budgetAnalyst, "the title names the occupation of the person assisted"),
    notNear(C.budgetAnalysts, "the same, by a name its words are near"),
  ),
  title(
    "Software Developers",
    never(C.developersGroup, "a group of occupations is not a job's occupation, so it is never a candidate"),
    near(C.softwareDeveloper, "the occupation, in the plural"),
    near(C.softwareDevelopers, "and O*NET's"),
  ),
  // ---- said in other words: no label stands in them, and only the vector index finds the concept
  line("Oversaw spending for three departments", near(C.manageBudgets, "managing budgets, in other words"), near(C.manageBudgetsOrFinances, "the activity, in other words")),
  line("Headed a crew of six engineers", near(C.leadATeam, "leading a team, in other words")),
  title("Coder", near(C.softwareDeveloper, "another word for the occupation"), near(C.softwareDevelopers, "and for O*NET's")),
  line("Hoping to oversee spending next year", notNear(C.manageBudgets, "an intention, not experience"), notNear(C.manageBudgetsOrFinances, "an intention, not experience")),
  line("Assisted the director who oversaw spending", notNear(C.manageBudgets, "someone else's budget"), notNear(C.manageBudgetsOrFinances, "someone else's budget")),
];
