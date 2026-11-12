import { useCallback, useEffect, useId, useMemo, useRef, type RefObject } from "react";
import type { ResumeBody, ResumeLine, ResumeView } from "../../shared/api";
import type { OwnerCommentThread, ShareComment } from "../../shared/sharing";
import { sheetModel } from "../../shared/sheet";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";
import { bodyLines, checkSentence, needsEvidence as needsCheck } from "../resume-check";
import { href } from "../router";
import { useSession } from "../session";
import { useTailor } from "../tailor";
import { LineCard } from "./jobs/LineCard";
import { lineText, LineMarks, type MarginLine } from "./jobs/LineMarks";
import { SHEET_QUERY, useMediaQuery } from "./jobs/use-media";
import { LineDetail } from "./LineItem";
import { useMarginLayout } from "./margin-layout";
import { GapsCard } from "./ResumeReport";
import { ResumePaper } from "./ResumePaper";
import { OwnerSuggestion } from "./SuggestedWording";
import { ActionError, Badge, ErrorNote } from "./ui";

/** A coach's suggested wordings on the owner's copies, as a resume's page reads them, and starts their checks. */
export interface LineSuggestions {
  threads: readonly OwnerCommentThread[];
  /** Why they couldn't be read, if they couldn't. The resume shows all the same. */
  error: string | null;
  reload: () => Promise<unknown>;
  /** True while any check is being started or running: Resumatic makes one thing at a time. */
  busy: boolean;
  onStarting: (starting: boolean) => void;
}

/** The suggestions on one line of one resume, oldest first, each with the line as the copy showed it. */
export function suggestionsOn(threads: readonly OwnerCommentThread[], resumeId: string, lineId: string): { comment: ShareComment; quote: string }[] {
  return threads
    .filter((thread) => thread.target.kind === "line" && thread.target.resumeId === resumeId && thread.target.lineId === lineId)
    .flatMap((thread) => thread.comments.filter((comment) => comment.suggestion).map((comment) => ({ comment, quote: thread.quote })));
}

/**
 * A resume version: its downloads, the one sentence about its check, the sheet exactly as the PDF
 * prints it, and beside it a mark on each line that differs and the card for the chosen line. Below
 * the marks come the tools that change this version and what isn't in the record. `chosen` is held
 * by the page, so it outlives this sheet when a newer version replaces it.
 */
export function ResumeSheet({
  resume,
  body,
  reload,
  readOnly = false,
  onLineEditingChange,
  editingOutdated = false,
  editing = false,
  fresh = false,
  chosen,
  onChoose,
  focusRequest,
  suggestions,
}: {
  resume: ResumeView;
  body: ResumeBody;
  reload: Reload;
  readOnly?: boolean;
  onLineEditingChange?: (id: string, active: boolean) => void;
  editingOutdated?: boolean;
  /** A line of this version is being edited: its card stays, and no other opens. */
  editing?: boolean;
  /** The page watched this resume finish, so the margin's marks tick in once. */
  fresh?: boolean;
  chosen: string | null;
  onChoose: (lineId: string | null) => void;
  focusRequest: RefObject<boolean>;
  /** Absent for a saved version, which is only read. */
  suggestions?: LineSuggestions;
}) {
  const { me } = useSession();
  const page = useRef<HTMLDivElement>(null);
  const cardHeading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const returnTo = useRef<string | null>(null);
  const cardId = `${useId()}-card`;
  const sheet = useMediaQuery(SHEET_QUERY);
  // The sheet prints the contact details captured with this version, as its PDF does.
  const profile = resume.profile ?? me.profile;
  const model = useMemo(() => sheetModel(profile, body), [profile, body]);
  const lines: MarginLine[] = useMemo(
    () => [
      ...(body.summary ? [{ line: body.summary, roleId: null }] : []),
      ...body.sections.flatMap((section) => section.lines.map((line) => ({ line, roleId: section.roleId }))),
    ],
    [body],
  );
  // What this version takes from facts marked sensitive. Those lines carry a mark of their own.
  const sensitive = resume.sensitiveUse;
  const sensitiveLines = useMemo(() => new Set(sensitive?.lineIds ?? []), [sensitive]);
  const tinted = useMemo(() => new Set(chosen ? [chosen] : []), [chosen]);
  const finalization = useAction();
  const isEmpty =
    !body.summary && body.sections.length === 0 && body.skills.length === 0;
  const lineIds = lines.map(({ line }) => line.id);
  const review = resume.provenance === "legacy" ? resume.legacyReview : undefined;
  const verified = new Set(review?.verifiedLineIds ?? []);
  const verifiedCount = lineIds.filter((id) => verified.has(id)).length;
  const readyToFinalize = !!review && (lineIds.length > 0 || body.skills.length > 0) && review.totalLines === lineIds.length &&
    verifiedCount === lineIds.length && review.headersReady && review.skillsReady;
  // The server applies the same guard to saved exports. Keep historical data
  // visible for recovery even when it cannot be downloaded or shared.
  const needsEvidence = needsCheck(resume, body);
  const sentence = checkSentence(resume, body);
  const threads = suggestions?.threads ?? [];
  const legacyReview = (line: ResumeLine) => (resume.provenance === "legacy" ? (verified.has(line.id) ? "verified" : "pending") : undefined);

  useMarginLayout(page, { stack: ".app-margin-stack", card: ".app-line-card" });

  // Choosing a line opens its card, with focus on its heading. While a line is being edited, its
  // card stays and no other opens.
  const open = useCallback((lineId: string) => {
    if (editing || lineId === chosen) return;
    focusRequest.current = true;
    onChoose(lineId);
  }, [editing, chosen, focusRequest, onChoose]);
  const close = useCallback(() => {
    if (editing || !chosen) return;
    returnTo.current = chosen;
    onChoose(null);
  }, [editing, chosen, onChoose]);
  const toggle = useCallback((lineId: string) => (lineId === chosen ? close() : open(lineId)), [chosen, close, open]);
  // A closed card hands focus back to its line's mark.
  useEffect(() => {
    if (chosen !== null || returnTo.current === null) return;
    focusRequest.current = false;
    buttons.current.get(returnTo.current)?.focus();
    returnTo.current = null;
  }, [chosen, focusRequest]);

  // A closed editor hands focus to its card's heading, so focus stays with the line.
  const focusCard = useCallback(() => cardHeading.current?.focus(), []);

  const shown = chosen ? lines.find(({ line }) => line.id === chosen) : undefined;
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
          <TailorAgain applicationId={resume.applicationId} />
        </div>
        {needsEvidence && (
          <p className="notice" role="status">
            This version contains wording or headings that haven’t been checked against your record, so its PDF,
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
            <p>{verifiedCount} of {review.totalLines} lines checked. Choose “Review line” for each line and select its supporting facts. Each completed line check counts toward your documents for this period.</p>
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
            <button type="button" disabled={!readyToFinalize || finalization.pending}
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
        {sentence && <p className="app-check-sentence">{sentence}</p>}
        {suggestions?.error && <ErrorNote message="Suggestions from your coach couldn’t be loaded." onRetry={suggestions.reload} />}
        <div className={fresh ? "app-resume-page is-fresh" : "app-resume-page"} ref={page}>
          <div className="rs-sheet-frame">
            {isEmpty ? (
              <p className="rs-empty">This resume has no lines. Confirm more facts, then tailor a new version.</p>
            ) : (
              <ResumePaper model={model} open={tinted} onToggleLine={open} />
            )}
          </div>
          <aside className="rs-margin app-margin" aria-label="Lines on this resume">
            <div className="app-margin-stack">
              <LineMarks
                lines={lines}
                chosen={chosen}
                cardId={cardId}
                onChoose={toggle}
                buttons={buttons}
                exceptions={(line) => ({
                  pending: legacyReview(line) === "pending",
                  sensitive: sensitiveLines.has(line.id),
                  suggested: suggestionsOn(threads, resume.id, line.id).some(({ comment }) => comment.suggestion?.state === "waiting"),
                })}
              />
              {shown && (
                <LineCard
                  key={shown.line.id}
                  cardId={cardId}
                  lineId={shown.line.id}
                  text={lineText(shown)}
                  presentation={sheet ? "sheet" : "margin"}
                  editing={editing}
                  focusRequest={focusRequest}
                  headingRef={cardHeading}
                  onClose={close}
                >
                  <LineDetail
                    resumeId={resume.id}
                    applicationId={resume.applicationId}
                    roleId={shown.roleId}
                    line={shown.line}
                    facts={resume.facts}
                    legacyReview={legacyReview(shown.line)}
                    reload={reload}
                    expectedVersion={resume.version}
                    readOnly={readOnly}
                    canRemove={!needsEvidence}
                    sensitive={sensitiveLines.has(shown.line.id)}
                    onEditingChange={onLineEditingChange}
                    editingOutdated={editingOutdated}
                    onEditorClosed={focusCard}
                  />
                  {!readOnly && suggestions && suggestionsOn(threads, resume.id, shown.line.id).map(({ comment, quote }) => (
                    <OwnerSuggestion
                      key={comment.id}
                      comment={comment}
                      quote={quote}
                      coachName={comment.name ?? null}
                      busy={suggestions.busy}
                      onStarting={suggestions.onStarting}
                      onChanged={suggestions.reload}
                      emphasis="plain"
                    />
                  ))}
                </LineCard>
              )}
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
                            {sensitive?.skills.includes(skill) && <> <Badge tone="note">Sensitive fact</Badge></>}
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

/** Every line of a body, by ID: whether a chosen line is still in a version. */
export const lineIdsOf = (body: ResumeBody) => new Set(bodyLines(body).map((line) => line.id));

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
