import { useRef, useState } from "react";
import type { SkillDurationPreview, SkillInterval, SkillIntervalInput, SkillSubjectRef } from "../../shared/skill-years";
import { MAX_SELECTED_SKILL_CLAIMS } from "../../shared/skill-years";
import { api } from "../api";
import { useAction, useResource } from "../hooks";
import { useSession } from "../session";
import { ErrorNote, Loading } from "./ui";

const refKey = (ref: SkillSubjectRef) => `${ref.kind}:${ref.id}`;
/** Keep an uncertain mutation's identity for retries; changing its input creates a new request. */
function useRequestIdentity() {
  const pending = useRef<{ input: string; key: string } | null>(null);
  return { key(input: unknown) {
    const value = JSON.stringify(input);
    if (pending.current?.input !== value) pending.current = { input: value, key: crypto.randomUUID() };
    return pending.current.key;
  }, acknowledge() { pending.current = null; } };
}

export function SkillYearsPanel() {
  const data = useResource(api.skillYears);
  const action = useAction();
  const requests = useRequestIdentity();
  const [subjectKey, setSubjectKey] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [ongoing, setOngoing] = useState(false);
  const [privatePeriod, setPrivatePeriod] = useState(false);
  const [editing, setEditing] = useState<SkillInterval | null>(null);
  const [preview, setPreview] = useState<{ subject: SkillSubjectRef; value: SkillDurationPreview } | null>(null);
  const subjects = data.data?.subjects ?? [];
  const selected = subjects.find((subject) => refKey(subject.ref) === subjectKey);
  function reset() { setEditing(null); setStart(""); setEnd(""); setOngoing(false); setPrivatePeriod(false); setPreview(null); }
  function edit(period: SkillInterval) {
    setEditing(period); setSubjectKey(refKey(period.subject.ref)); setStart(period.start);
    setEnd(period.end ?? ""); setOngoing(period.ongoing); setPrivatePeriod(period.private); setPreview(null);
  }
  return <section className="rs-panel" aria-labelledby="skill-periods-heading">
    <h2 id="skill-periods-heading" className="rs-h3">Time using a skill</h2>
    <p>Confirm the periods when you actually used one skill. Role dates are never used. Overlapping periods count once; uncertain dates produce a conservative minimum.</p>
    {data.error && <ErrorNote message={data.error} onRetry={data.reload} />}
    {!data.data && !data.error && <Loading>Loading skill periods…</Loading>}
    {data.data && <>
      <form className="app-stack" onSubmit={(event) => {
        event.preventDefault(); if (!selected) return;
        const input: SkillIntervalInput = { subject: selected.ref, start: start.trim(), end: ongoing ? null : end.trim(), ongoing, private: privatePeriod };
        const change = editing ? { id: editing.id, expectedRevision: editing.revision } : undefined;
        void action.run(async () => { await api.saveSkillInterval(input, requests.key(["save", input, change]), change); requests.acknowledge(); reset(); data.reload(); });
      }}>
        <label>Confirmed skill or concept<select value={subjectKey} required disabled={action.pending} onChange={(event) => { setSubjectKey(event.target.value); setPreview(null); }}>
          <option value="">Choose a skill</option>
          {subjects.map((subject) => <option key={refKey(subject.ref)} value={refKey(subject.ref)}>{subject.label}{subject.private ? " (private)" : ""} · {subject.ref.kind === "fact" ? "confirmed skill" : "confirmed concept"}</option>)}
        </select></label>
        {editing && !selected && <p role="status">This skill’s supporting record changed. Choose a current confirmed skill before saving these dates again.</p>}
        <label>First use (YYYY or YYYY-MM)<input required value={start} placeholder="2020 or 2020-03" maxLength={7} disabled={action.pending} onChange={(event) => setStart(event.target.value)} /></label>
        <label><input type="checkbox" checked={ongoing} disabled={action.pending} onChange={(event) => setOngoing(event.target.checked)} /> I still use this skill</label>
        {!ongoing && <label>Last use (YYYY or YYYY-MM)<input required value={end} placeholder="2024 or 2024-09" maxLength={7} disabled={action.pending} onChange={(event) => setEnd(event.target.value)} /></label>}
        <label><input type="checkbox" checked={privatePeriod} disabled={action.pending} onChange={(event) => setPrivatePeriod(event.target.checked)} /> Keep this period private</label>
        <p className="meta">Private periods and periods supported by private facts cannot be used in a resume. Saving means you confirm you used this exact skill during this period; it does not infer use throughout any role.</p>
        <div className="actions"><button type="submit" disabled={action.pending || !selected}>{editing ? "Confirm changed period" : "Confirm this period"}</button>{editing && <button type="button" disabled={action.pending} onClick={reset}>Cancel edit</button>}</div>
      </form>
      <ul className="app-list">{data.data.intervals.filter((period) => period.state === "confirmed").map((period) => <li key={period.id}>
        <p>{period.subject.label}: {period.start} to {period.ongoing ? `ongoing (through ${data.data!.asOf})` : period.end}{period.private ? " · Private" : ""}</p>
        <div className="actions"><button type="button" disabled={action.pending} onClick={() => edit(period)}>Edit period</button><button type="button" disabled={action.pending} onClick={() => void action.run(async () => { await api.withdrawSkillInterval(period.id, period.revision, requests.key(["withdraw", period.id, period.revision])); requests.acknowledge(); setPreview(null); data.reload(); })}>Withdraw period</button></div>
      </li>)}</ul>
      <button type="button" disabled={action.pending || !selected} onClick={() => { if (!selected) return; const subject = selected.ref; void action.run(async () => setPreview({ subject, value: await api.previewSkillDuration(subject) })); }}>Preview total for chosen skill</button>
      {preview && <div className="app-stack" role="status"><p>{preview.value.text}</p><p className="meta">The dates establish between {preview.value.bounds.lowerMonths} and {preview.value.bounds.upperMonths} complete months. The printed claim uses the lower bound at the least precise supplied unit. It stays fixed as of {preview.value.asOf}; ongoing periods do not silently grow.</p>{preview.value.private && <p>This total is private and cannot be selected for a resume.</p>}<button type="button" disabled={action.pending} onClick={() => void action.run(async () => { await api.confirmSkillDuration(preview.subject, preview.value, requests.key(["claim", preview.subject, preview.value.inputHash])); requests.acknowledge(); setPreview(null); data.reload(); })}>Confirm this exact total</button></div>}
      <h3 className="rs-h3">Confirmed totals</h3>
      <ul className="app-list">{data.data.claims.map((claim) => <li key={claim.id}>{claim.text} · {claim.current ? (claim.private ? "Private" : "Available to choose for a new resume") : "Inputs changed; confirm a new total before using"}</li>)}</ul>
    </>}
    {action.error && <ErrorNote message={action.error} />}
  </section>;
}

export function SkillDurationChoices(props: { selected: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const { me } = useSession();
  if (!me.capabilities?.skillYears) return null;
  return <EnabledSkillDurationChoices {...props} />;
}
function EnabledSkillDurationChoices({ selected, onChange, disabled }: { selected: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const data = useResource(api.skillYears);
  const claims = data.data?.claims.filter((claim) => claim.current && !claim.private) ?? [];
  // Do not hide a stale selection. Sending it makes the server refuse the run until the owner
  // explicitly removes it, even if a claim changed after the choices were loaded.
  const missing = selected.filter((id) => !claims.some((claim) => claim.id === id));
  return <fieldset disabled={disabled}><legend>Optional confirmed skill totals</legend>
    <p>Choose any totals to print exactly in this resume. None are selected automatically.</p>
    {data.error && <ErrorNote message={data.error} onRetry={data.reload} />}
    {!data.data && !data.error && <Loading>Loading confirmed totals…</Loading>}
    {data.data && !claims.length && <p>No current public totals. Confirm periods under Facts → Skills first.</p>}
    {claims.map((claim) => <label key={claim.id}><input type="checkbox" checked={selected.includes(claim.id)} disabled={!selected.includes(claim.id) && selected.length >= MAX_SELECTED_SKILL_CLAIMS} onChange={(event) => onChange(event.target.checked ? [...selected.filter((id) => !claims.some((other) => other.id === id && other.skillKey === claim.skillKey)), claim.id] : selected.filter((id) => id !== claim.id))} /> {claim.text}</label>)}
    {missing.map((id) => <label key={id}><input type="checkbox" checked onChange={() => onChange(selected.filter((value) => value !== id))} /> Unavailable total — remove this selection</label>)}
  </fieldset>;
}
