import { useCallback, useMemo, useRef, useState } from "react";
import type { ResumeBody, ResumeView } from "../../shared/api";
import { sheetModel } from "../../shared/sheet";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";
import { href } from "../router";
import { useSession } from "../session";
import { useTailor } from "../tailor";
import { LineItem } from "./LineItem";
import { useMarginLayout } from "./margin-layout";
import { GapsCard, ReportCard } from "./ResumeReport";
import { ResumePaper } from "./ResumePaper";
import { ActionError, Badge } from "./ui";

export function ResumeSheet({
  resume,
  body,
  reload,
  readOnly = false,
  onLineEditingChange,
  editingOutdated = false,
  fresh = false,
}: {
  resume: ResumeView;
  body: ResumeBody;
  reload: Reload;
  readOnly?: boolean;
  onLineEditingChange?: (id: string, active: boolean) => void;
  editingOutdated?: boolean;
  /** The page watched this resume finish, so the margin's marks tick in once. */
  fresh?: boolean;
}) {
  const { me } = useSession();
  const page = useRef<HTMLDivElement>(null);
  // The sheet prints the contact details captured with this version, as its PDF does.
  const profile = resume.profile ?? me.profile;
  const model = useMemo(() => sheetModel(profile, body), [profile, body]);
  const lineIds = useMemo(
    () => [
      ...(body.summary ? [body.summary.id] : []),
      ...body.sections.flatMap((s) => s.lines.map((l) => l.id)),
    ],
    [body],
  );
  // What this version takes from facts marked sensitive. Those lines' notes start open, so the
  // person sees which ones they are without hunting for them.
  const sensitive = resume.sensitiveUse;
  const sensitiveLines = useMemo(() => new Set(sensitive?.lineIds ?? []), [sensitive]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(resume.sensitiveUse?.lineIds ?? []));
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
  const readyToFinalize = !!review && (lineIds.length > 0 || body.skills.length > 0) && review.totalLines === lineIds.length &&
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

  const notes = [
    ...(body.summary ? [{ line: body.summary, roleId: null }] : []),
    ...body.sections.flatMap((section) => section.lines.map((line) => ({ line, roleId: section.roleId }))),
  ];
  useMarginLayout(page);
  const skillTools = !readOnly && (review || !needsEvidence) && body.skills.length > 0;
  const sectionTools = !readOnly && !!review && body.sections.length > 0;

  return (
    <div className="resume-view">
        <div className="toolbar">
          {!needsEvidence && !sensitive && <><a
            className="rs-btn rs-btn--primary"
            href={api.pdfUrl(resume.id, resume.version)}
            download={`resume-v${resume.version}.pdf`}
          >
            Download PDF
          </a>
          <a
            className="rs-btn"
            href={api.docxUrl(resume.id, resume.version)}
            download={`resume-v${resume.version}.docx`}
          >
            Download Word
          </a>
          <a
            className="rs-btn"
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
            This version contains wording or headings without verified evidence, so its PDF,
            Word download and print preview are unavailable. Your text is still here.{" "}
            {!readOnly && resume.provenance === "snapshot"
              ? "Start a line-by-line review below, or confirm your facts and tailor a new version."
              : !readOnly && review
                ? "Review each line against confirmed facts to prepare a checked version."
                : "Select Latest or confirm facts and tailor a new version to create a downloadable resume."}
          </p>
        )}
        {sensitive && (
          <p className="notice" role="status">
            This version uses a fact you’ve marked sensitive, or was checked against the line of an upload one was
            read from, so it can’t be downloaded or shared, and connected apps can’t read it.{" "}
            {readOnly
              ? "Your text is still here. Select Latest to change it."
              : "Remove the lines and skills marked ‘Sensitive fact’, or tailor a new version. Your text is still here."}
          </p>
        )}
        {!readOnly && needsEvidence && resume.provenance === "snapshot" && resume.needsGroundingReview && (
          <section className="card" aria-label="Review blocked resume">
            <h2>Review this resume</h2>
            <p>Start a new review version, then check each line against confirmed facts. The review becomes your latest version and cannot be downloaded until all checks pass. Your existing versions and share snapshots remain in your data; links to versions needing review are unavailable.</p>
            <button type="button" disabled={finalization.pending}
              onClick={() => void finalization.run(async () => {
                await api.beginResumeReview(resume.id, resume.version);
                await reload();
              })}>
              {finalization.pending ? "Starting…" : "Start review"}
            </button>
            <ActionError message={finalization.error} />
          </section>
        )}
        {!readOnly && review && (
          <section className="card" aria-label="Review older resume">
            <h2>Review this older resume</h2>
            <p>{verifiedCount} of {review.totalLines} lines checked. Choose “Review line” for each line and select its supporting facts. Each completed line check uses one output.</p>
            {(!review.headersReady || !review.skillsReady) && (
              <p className="notice">
                {!review.headersReady && !review.skillsReady
                  ? "Some headings and skills don’t match confirmed records."
                  : !review.headersReady
                    ? "Some headings don’t match confirmed roles."
                    : "Some skills don’t match confirmed facts."}{" "}
                Review your confirmed experience in <a href={href.facts}>Facts</a>, then return and refresh this page.
                You can also remove a section or skill from this review version below.
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
        {resume.report && <ReportCard report={resume.report} />}
        <div className={fresh ? "resume-page is-fresh" : "resume-page"} ref={page}>
          <div className="rs-sheet-frame">
            {isEmpty ? (
              <p className="rs-empty">This resume has no lines. Confirm more facts, then tailor a new version.</p>
            ) : (
              <ResumePaper model={model} open={open} onToggleLine={toggle} />
            )}
          </div>
          <aside className="rs-margin app-margin" aria-label="How each line was checked">
            <div className="app-notes">
              {notes.map(({ line, roleId }) => (
                <LineItem
                  key={line.id}
                  resumeId={resume.id}
                  applicationId={resume.applicationId}
                  roleId={roleId}
                  line={line}
                  facts={resume.facts}
                  legacyReview={resume.provenance === "legacy" ? (verified.has(line.id) ? "verified" : "pending") : undefined}
                  expanded={open.has(line.id)}
                  onToggle={toggle}
                  reload={reload}
                  expectedVersion={resume.version}
                  readOnly={readOnly}
                  canRemove={!needsEvidence}
                  sensitive={sensitiveLines.has(line.id)}
                  onEditingChange={onLineEditingChange}
                  editingOutdated={editingOutdated}
                />
              ))}
            </div>
            <div className="app-margin-end">
              {!profile.name && !readOnly && (
                <p className="rs-meta">
                  Add your name and contact details on <a href={href.account}>Account</a>. They print at the top of
                  every resume.
                </p>
              )}
              {(sectionTools || skillTools) && (
                <section className="rs-panel app-sheet-tools" aria-labelledby="sheet-tools-heading">
                  <h2 id="sheet-tools-heading" className="rs-h3">
                    Change this version
                  </h2>
                  {sectionTools && (
                    <ul className="app-tool-list">
                      {body.sections.map((section, index) => (
                        <li key={index}>
                          <span>{[section.title, section.org].filter(Boolean).join(", ")}</span>
                          <button
                            type="button"
                            className="rs-btn rs-btn--sm"
                            disabled={finalization.pending}
                            aria-label={`Remove section ${section.org}`}
                            onClick={() =>
                              void finalization.run(async () => {
                                await api.removeLegacySection(resume.id, index, resume.version);
                                await reload();
                              })
                            }
                          >
                            Remove section
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {skillTools && (
                    <ul className="app-tool-list">
                      {body.skills.map((skill, index) => (
                        <li key={index}>
                          <span>
                            {skill}
                            {sensitive?.skills.includes(skill) && <> <Badge tone="sensitive">Sensitive fact</Badge></>}
                          </span>
                          <button
                            type="button"
                            className="rs-btn rs-btn--sm"
                            disabled={finalization.pending}
                            aria-label={`Remove skill ${skill}`}
                            onClick={() =>
                              void finalization.run(async () => {
                                if (review) await api.removeLegacySkill(resume.id, index, resume.version);
                                else await api.removeResumeSkill(resume.id, index, resume.version);
                                await reload();
                              })
                            }
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!review && <ActionError message={finalization.error} />}
                </section>
              )}
              {resume.report ? (
                <GapsCard gaps={resume.report.gaps} applicationId={resume.applicationId} readOnly={readOnly} />
              ) : (
                <p className="rs-meta">No report is available for this resume.</p>
              )}
            </div>
          </aside>
        </div>
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
