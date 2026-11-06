import { useCallback, useMemo, useState } from "react";
import type {
  ResumeBody,
  ResumeLine,
  ResumeSection,
  ResumeView,
  RoleKind,
} from "../../shared/api";
import { api } from "../api";
import { formatDateRange, SECTION_HEADING } from "../format";
import { useAction, type Reload } from "../hooks";
import { href } from "../router";
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

export function ResumeSheet({
  resume,
  body,
  reload,
  readOnly = false,
}: {
  resume: ResumeView;
  body: ResumeBody;
  reload: Reload;
  readOnly?: boolean;
}) {
  const lineIds = useMemo(
    () => [
      ...(body.summary ? [body.summary.id] : []),
      ...body.sections.flatMap((s) => s.lines.map((l) => l.id)),
    ],
    [body],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const finalization = useAction();
  const allOpen = lineIds.length > 0 && lineIds.every((id) => open.has(id));
  const isEmpty =
    !body.summary && body.sections.length === 0 && body.skills.length === 0;
  const lines = [
    ...(body.summary ? [body.summary] : []),
    ...body.sections.flatMap((section) => section.lines),
  ];
  const review = resume.provenance === "legacy" ? resume.legacyReview : undefined;
  const verified = new Set(review?.verifiedLineIds ?? []);
  const verifiedCount = lineIds.filter((id) => verified.has(id)).length;
  const readyToFinalize = !!review && review.totalLines === lineIds.length &&
    verifiedCount === lineIds.length && review.headersReady && review.skillsReady;
  // The server applies the same guard to saved exports. Keep historical data
  // visible for recovery even when it cannot be downloaded or shared.
  const needsEvidence = resume.needsGroundingReview === true || resume.provenance !== "snapshot" || lines.some(
    (item) => !["kept", "repaired", "replaced"].includes(item.status) || item.factIds.length === 0 ||
      item.factIds.some((id) => !resume.facts[id]?.text?.trim()),
  ) || body.skills.some((skill) => !Object.values(resume.facts).some((fact) => !!fact.text && fact.text === skill));

  const toggle = useCallback(
    (id: string) =>
      setOpen((previous) => {
        const next = new Set(previous);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  const line = (l: ResumeLine, roleId: string | null) => (
    <LineItem
      key={l.id}
      resumeId={resume.id}
      applicationId={resume.applicationId}
      roleId={roleId}
      line={l}
      facts={resume.facts}
      legacyReview={resume.provenance === "legacy" ? (verified.has(l.id) ? "verified" : "pending") : undefined}
      expanded={open.has(l.id)}
      onToggle={toggle}
      reload={reload}
      expectedVersion={resume.version}
      readOnly={readOnly}
    />
  );

  return (
    <div className="resume-layout">
      <div>
        <div className="toolbar">
          {!needsEvidence && <><a
            className="button primary"
            href={api.pdfUrl(resume.id, resume.version)}
            download={`resume-v${resume.version}.pdf`}
          >
            Download PDF
          </a>
          <a
            className="button"
            href={api.docxUrl(resume.id, resume.version)}
            download={`resume-v${resume.version}.docx`}
          >
            Download Word
          </a>
          <a
            className="button"
            href={api.previewUrl(resume.id, resume.version)}
            target="_blank"
            rel="noopener"
          >
            Print preview
          </a></>}
          {lineIds.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen(allOpen ? new Set() : new Set(lineIds))}
            >
              {allOpen ? "Hide all evidence" : "Show all evidence"}
            </button>
          )}
          <TailorAgain applicationId={resume.applicationId} />
        </div>
        {needsEvidence && (
          <p className="notice" role="status">
            This version contains wording without verified evidence, so its PDF,
            Word download and print preview are unavailable. Your text is still here.{" "}
            {!readOnly && resume.provenance === "snapshot"
              ? "Review the cited facts, then confirm facts and tailor a new version."
              : !readOnly && review
                ? "Review each line against confirmed facts to prepare a checked version."
                : "Select Latest or confirm facts and tailor a new version to create a downloadable resume."}
          </p>
        )}
        {!readOnly && review && (
          <section className="card" aria-label="Review older resume">
            <h2>Review this older resume</h2>
            <p>{verifiedCount} of {review.totalLines} lines checked. Choose “Review line” for each line and select its supporting facts. Each completed line check uses one output.</p>
            {(!review.headersReady || !review.skillsReady) && (
              <p className="notice">
                {!review.headersReady && !review.skillsReady
                  ? "Some headings and skills don't match confirmed records."
                  : !review.headersReady
                    ? "Some headings don't match confirmed roles."
                    : "Some skills don't match confirmed facts."}{" "}
                Review your confirmed experience in <a href={href.sources}>Sources &amp; facts</a>, then return and refresh this page.
              </p>
            )}
            <button type="button" className="primary" disabled={!readyToFinalize || finalization.pending}
              onClick={() => void finalization.run(async () => {
                await api.finalizeLegacyResume(resume.id, resume.version);
                await reload();
              })}>
              {finalization.pending ? "Preparing…" : "Create checked version"}
            </button>
            <p className="hint">This creates a new version. Your saved versions and existing share links are not changed.</p>
            <ActionError message={finalization.error} />
          </section>
        )}
        <article className="paper" aria-label="Resume preview">
          {isEmpty && (
            <p className="meta">
              This resume has no lines. Confirm more facts, then tailor a new
              version.
            </p>
          )}
          {body.summary && (
            <section className="paper-section">
              <h2>Summary</h2>
              <ul className="plain-list lines summary">{line(body.summary, null)}</ul>
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
                    <p className="entry-dates">
                      {formatDateRange(s.startDate, s.endDate, s.unknownEndStartDate)}
                    </p>
                  </div>
                  {s.lines.length > 0 && (
                    <ul className="plain-list lines">{s.lines.map((item) => line(item, s.roleId))}</ul>
                  )}
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
      <button
        type="button"
        onClick={() => void tailor(applicationId)}
        disabled={pending}
      >
        {pending ? "Starting…" : "Tailor a new version"}
      </button>
      <ActionError message={error} />
    </>
  );
}
