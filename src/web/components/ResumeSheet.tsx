import { useCallback, useMemo, useState } from "react";
import type { ResumeBody, ResumeLine, ResumeSection, ResumeView, RoleKind } from "../../shared/api";
import { api } from "../api";
import { formatDateRange, SECTION_HEADING } from "../format";
import type { Reload } from "../hooks";
import { useTailor } from "../tailor";
import { LineItem } from "./LineItem";
import { GapsCard, ReportCard } from "./ResumeReport";
import { ActionError } from "./ui";

/** Sections grouped by kind, in the order each kind first appears. */
function groupSections(sections: ResumeSection[]) {
  const groups: { kind: RoleKind; sections: ResumeSection[] }[] = [];
  for (const section of sections) {
    const group = groups.find((g) => g.kind === section.kind);
    if (group) group.sections.push(section);
    else groups.push({ kind: section.kind, sections: [section] });
  }
  return groups;
}

export function ResumeSheet({ resume, body, reload }: { resume: ResumeView; body: ResumeBody; reload: Reload }) {
  const lineIds = useMemo(
    () => [...(body.summary ? [body.summary.id] : []), ...body.sections.flatMap((s) => s.lines.map((l) => l.id))],
    [body],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const allOpen = lineIds.length > 0 && lineIds.every((id) => open.has(id));
  const isEmpty = !body.summary && body.sections.length === 0 && body.skills.length === 0;

  const toggle = useCallback(
    (id: string) =>
      setOpen((previous) => {
        const next = new Set(previous);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  const line = (l: ResumeLine) => (
    <LineItem
      key={l.id}
      resumeId={resume.id}
      line={l}
      facts={resume.facts}
      expanded={open.has(l.id)}
      onToggle={toggle}
      reload={reload}
    />
  );

  return (
    <div className="resume-layout">
      <div>
        <div className="toolbar">
          <a className="button primary" href={api.pdfUrl(resume.id)} download="resume.pdf">
            Download PDF
          </a>
          {lineIds.length > 0 && (
            <button type="button" onClick={() => setOpen(allOpen ? new Set() : new Set(lineIds))}>
              {allOpen ? "Hide all evidence" : "Show all evidence"}
            </button>
          )}
          <TailorAgain applicationId={resume.applicationId} />
        </div>
        <article className="paper" aria-label="Resume preview">
          {isEmpty && <p className="meta">This resume has no lines. Confirm more facts, then tailor a new version.</p>}
          {body.summary && (
            <section className="paper-section">
              <h2>Summary</h2>
              <ul className="plain-list lines summary">{line(body.summary)}</ul>
            </section>
          )}
          {groupSections(body.sections).map(({ kind, sections }) => (
            <section className="paper-section" key={kind}>
              <h2>{SECTION_HEADING[kind]}</h2>
              {sections.map((s) => (
                <div className="entry" key={s.roleId}>
                  <div className="entry-head">
                    <div>
                      <p className="entry-org">{s.org}</p>
                      {s.title && <p className="entry-title">{s.title}</p>}
                    </div>
                    <p className="entry-dates">{formatDateRange(s.startDate, s.endDate)}</p>
                  </div>
                  {s.lines.length > 0 && <ul className="plain-list lines">{s.lines.map(line)}</ul>}
                </div>
              ))}
            </section>
          ))}
          {body.skills.length > 0 && (
            <section className="paper-section">
              <h2>Skills</h2>
              <p>{body.skills.join(" · ")}</p>
            </section>
          )}
        </article>
      </div>
      <aside className="resume-aside" aria-label="How this resume was checked">
        {resume.report ? (
          <>
            <ReportCard report={resume.report} />
            <GapsCard gaps={resume.report.gaps} />
          </>
        ) : (
          <p className="meta">No report is available for this resume.</p>
        )}
      </aside>
    </div>
  );
}

function TailorAgain({ applicationId }: { applicationId: string }) {
  const { tailor, pending, error } = useTailor();
  return (
    <>
      <button type="button" onClick={() => void tailor(applicationId)} disabled={pending}>
        {pending ? "Starting…" : "Tailor a new version"}
      </button>
      <ActionError message={error} />
    </>
  );
}
