import { SkillYearsPanel } from "../../components/SkillYears";
import { useSession } from "../../session";
import type { FactView, RoleView } from "../../../shared/api";
import { cleanExtractedText } from "../../../shared/clean";
import { PlaceholderSection } from "../../components/Placeholder";
import { SourceEvidence } from "../../components/SourceEvidence";
import { Badge, EmptyState, ErrorNote, Loading, PageHeader } from "../../components/ui";
import { count } from "../../format";
import { useResource } from "../../hooks";
import { href } from "../../router";
import { isReading, loadVault, sourceLabel, type Vault } from "../../vault";
import "../../styles/rooms/facts.css";

// Facts › Skills: the skills the person's confirmed facts name, each with where it came from. Only
// a skill that can be used is listed: confirmed, under no role or a confirmed one. Tags read by
// a model aren't shown, because nobody has confirmed them.

export interface Skill {
  name: string;
  copies: FactView[];
}

/** The same skill, however it was written: its words cleaned, spaces made one, in lower case. */
const skillKey = (fact: FactView) => cleanExtractedText(fact.text).replace(/\s+/g, " ").trim().toLowerCase();

/** The confirmed skills, each with every fact that names it, in alphabetical order. */
export function confirmedSkills(vault: Vault): Skill[] {
  const confirmedRoles = new Set(vault.roles.filter((role) => role.state === "confirmed").map((role) => role.id));
  const skills = new Map<string, Skill>();
  for (const fact of vault.facts) {
    if (fact.kind !== "skill" || fact.state !== "confirmed") continue;
    if (fact.roleId !== null && !confirmedRoles.has(fact.roleId)) continue;
    const key = skillKey(fact);
    if (!key) continue;
    const skill = skills.get(key);
    if (skill) skill.copies.push(fact);
    else skills.set(key, { name: fact.origin === "extracted" ? cleanExtractedText(fact.text) : fact.text.trim(), copies: [fact] });
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function FactsSkills() {
  const { me } = useSession();
  const vault = useResource(loadVault, isReading);
  return (
    <>
      <PageHeader title="Skills">The skills your confirmed facts name, each with where it came from.</PageHeader>
      {vault.error && <ErrorNote message={vault.error} onRetry={vault.reload} />}
      {!vault.data && !vault.error && <Loading>Loading your skills…</Loading>}
      {vault.data && (
        <div className="app-stack facts-skills">
          <SkillList vault={vault.data} />
          {me.capabilities?.skillYears ? <SkillYearsPanel /> : <PlaceholderSection name="factsSkillYears" />}
        </div>
      )}
    </>
  );
}

function SkillList({ vault }: { vault: Vault }) {
  const skills = confirmedSkills(vault);
  const filenames = new Map(vault.sources.map((s) => [s.id, s.filename] as const));
  const roles = new Map(vault.roles.map((role) => [role.id, role] as const));
  if (skills.length === 0) {
    return (
      <EmptyState title="No confirmed skills yet">
        Say “That’s right” to a skill under <a href={href.facts}>To check</a>, or add one yourself under{" "}
        <a href={href.factsAll}>All facts</a>.
      </EmptyState>
    );
  }
  return (
    <section className="rs-panel" aria-labelledby="facts-skills-heading">
      <h2 id="facts-skills-heading" className="rs-h3">
        {count(skills.length, "skill")}
      </h2>
      <ul className="app-list facts-skills__list">
        {skills.map((skill) => (
          <li key={skill.copies[0]!.id}>
            <p className="app-inline">
              <span className="app-q__t">{skill.name}</span>
              {skill.copies.some((copy) => copy.sensitive) && <Badge tone="note">Private</Badge>}
            </p>
            <p className="rs-note__label">Where it came from</p>
            <ul className="facts-skills__from">
              {skill.copies.map((copy) => (
                <li key={copy.id}>
                  <p className="rs-meta">
                    {where(copy, copy.roleId ? (roles.get(copy.roleId) ?? null) : null)} {from(copy, filenames)}
                  </p>
                  {copy.quote && copy.span && copy.sourceId && (
                    <SourceEvidence sourceId={copy.sourceId} quote={copy.quote} span={copy.span} />
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function where(fact: FactView, role: RoleView | null): string {
  return fact.roleId && role ? `At ${role.org}.` : "Not tied to a role.";
}

function from(fact: FactView, filenames: ReadonlyMap<string, string>): string {
  if (fact.interview) return `From your answer to: ${fact.interview.question}`;
  if (fact.quote && fact.sourceId) return `From ${sourceLabel(filenames, fact.sourceId)}.`;
  return "Added by you.";
}
