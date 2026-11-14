import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import type { ApplicationDetail, ResumeView } from "../../../shared/api";
import type { DocumentKind } from "../../../shared/documents";
import type { OwnerCommentThread } from "../../../shared/sharing";
import { api, ApiError } from "../../api";
import { DocumentList, runningElsewhere, StartNotes, useJobDocuments } from "../../components/Documents";
import { lineIdsOf, ResumeSheet, type LineSuggestions } from "../../components/ResumeSheet";
import { TailorProgress } from "../../components/TailorProgress";
import { ActionError, EmptyState, ErrorNote, Field, Loading } from "../../components/ui";
import { formatDateTime } from "../../format";
import { useAction, useResource, type Reload, type Resource } from "../../hooks";
import { href } from "../../router";
import { useSession } from "../../session";
import { resumeErrorMessage } from "../../source-error";
import { SkillDurationChoices } from "../../components/SkillYears";
import { useTailor } from "../../tailor";

// A job's Resume tab: the resumes tailored to it, then the chosen one, which is the address's or
// else the newest. A ready resume shows its downloads, one sentence about its check, the sheet as
// the PDF prints it, a mark beside each line that differs, and the card of the line chosen. Under
// it come the tools that change the version, what isn't in the record, and wording checks.

const REFINE: readonly DocumentKind[] = ["refine"];

export function JobResume({ job, reloadJob, resume }: { job: ApplicationDetail; reloadJob: Reload; resume?: Resource<ResumeView> }) {
  const resumes = [...job.resumes].sort((a, b) => b.createdAt - a.createdAt);
  const newest = resumes[0];
  // The resume a line is being edited on stays shown when a newer one for the job arrives, from
  // another window or a connected app, so the draft isn't lost; the newest is shown once the edit ends.
  const [editingOn, setEditingOn] = useState<string | null>(null);
  const shown = (editingOn !== null ? resumes.find((item) => item.id === editingOn) : undefined) ?? newest;
  const chosenId = resume ? resume.data?.id : shown?.id;
  const listed = resumes.find((item) => item.id === chosenId);
  const id = useId();
  const tailor = useTailor();
  const [skillClaimIds, setSkillClaimIds] = useState<string[]>([]);

  return (
    <>
      <section className="section app-job-section" aria-labelledby={`${id}-list`}>
        <h2 id={`${id}-list`}>Resumes for this job</h2>
        {resumes.length === 0 ? (
          <>
            <EmptyState title="No resume for this job yet.">Tailoring writes one from your confirmed facts and checks every line.</EmptyState>
            <SkillDurationChoices selected={skillClaimIds} onChange={setSkillClaimIds} disabled={tailor.pending} />
            <div className="actions">
              <button type="button" className="primary" disabled={tailor.pending} onClick={() => void tailor.tailor(job.id, skillClaimIds)}>
                {tailor.pending ? "Starting…" : "Tailor a resume"}
              </button>
            </div>
            <ActionError message={tailor.error} />
          </>
        ) : (
          <ul className="plain-list resume-list app-resume-list">
            {resumes.map((item, index) => (
              <li key={item.id}>
                <a href={href.jobResume(job.id, item.id)} aria-current={item.id === chosenId ? "page" : undefined}>
                  Tailored {formatDateTime(item.createdAt)}
                </a>
                {index === 0 && resumes.length > 1 && <span className="app-latest">Latest</span>}
              </li>
            ))}
          </ul>
        )}
        {!resume && shown && newest && shown.id !== newest.id && (
          <p className="rs-meta" role="status">
            A newer resume for this job was started. Finish or cancel your edit to see it.
          </p>
        )}
      </section>
      {resume ? (
        <ChosenResume jobId={job.id} resource={resume} createdAt={listed?.createdAt} reloadJob={reloadJob} />
      ) : (
        shown && <NewestResume key={shown.id} jobId={job.id} id={shown.id} createdAt={shown.createdAt} reloadJob={reloadJob} onEditing={setEditingOn} />
      )}
    </>
  );
}

function NewestResume({ jobId, id, createdAt, reloadJob, onEditing }: {
  jobId: string;
  id: string;
  createdAt: number;
  reloadJob: Reload;
  onEditing: (resumeId: string | null) => void;
}) {
  const resource = useResource(
    () => api.resume(id),
    (r) => r.state === "running",
  );
  return <ChosenResume jobId={jobId} resource={resource} createdAt={createdAt} reloadJob={reloadJob} onEditing={onEditing} />;
}

/** The chosen resume, as a section headed by when it was tailored, in whatever state it is in. */
function ChosenResume({ jobId, resource, createdAt, reloadJob, onEditing }: {
  jobId: string;
  resource: Resource<ResumeView>;
  createdAt?: number;
  reloadJob: Reload;
  /** Told which resume a line is being edited on, and when no line is. */
  onEditing?: (resumeId: string | null) => void;
}) {
  const r = resource.data;
  const { refreshMe } = useSession();
  const heading = useRef<HTMLHeadingElement>(null);
  const wasRunning = useRef(false);
  // Set once this page watches the resume finish, so the margin's marks tick in once; never on a later visit.
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (r && wasRunning.current && r.state !== "running") {
      void refreshMe();
      void reloadJob();
      if (r.state === "ready") setFresh(true);
    }
    wasRunning.current = r?.state === "running";
  }, [r, refreshMe, reloadJob]);
  const when = r?.createdAt ?? createdAt;
  const id = useId();
  const ready = r?.state === "ready" && !!r.body;

  return (
    <section className="section app-job-section app-chosen-resume" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} tabIndex={-1} ref={heading}>
        {when === undefined ? "Tailored resume" : `Tailored ${formatDateTime(when)}`}
      </h2>
      {resource.error && <ErrorNote message={resource.error} onRetry={resource.reload} />}
      {!r && !resource.error && <Loading>Loading this resume…</Loading>}
      {r?.state === "running" && <RunningResume resume={r} reload={resource.reload} />}
      {r?.state === "failed" && <TailorFailed resume={r} />}
      {r?.state === "ready" &&
        (r.body ? (
          <ReadyResume key={r.id} resume={r} reload={resource.reload} fresh={fresh} heading={heading} onEditing={onEditing} />
        ) : (
          <ErrorNote message="This resume is marked ready, but it has no content. Try tailoring a new version." />
        ))}
      {/* Wording checks for the job can be stopped or tried again whatever state this resume is in. */}
      {(r || resource.error) && !ready && <RefineWording applicationId={jobId} onUpdated={resource.reload} />}
    </section>
  );
}

function RunningResume({ resume, reload }: { resume: ResumeView; reload: Reload }) {
  const cancel = useAction();
  return (
    <>
      <TailorProgress step={resume.step} dispatchUncertain={resume.dispatchUncertain} cancellationPending={resume.cancellationPending} />
      {!resume.cancellationPending && (
        <button type="button" className="small app-cancel-run" disabled={cancel.pending} onClick={() => void cancel.run(async () => {
          await api.cancelResume(resume.id);
          await reload();
        })}>
          {cancel.pending ? "Stopping…" : "Cancel tailoring"}
        </button>
      )}
      <ActionError message={cancel.error} />
    </>
  );
}

/** The suggestions waiting for an answer, and those being checked, by ID. */
const checkingIds = (threads: readonly OwnerCommentThread[]) =>
  new Set(threads.flatMap((thread) => thread.comments).filter((comment) => comment.suggestion?.state === "checking").map((comment) => comment.id));

function ReadyResume({
  resume,
  reload,
  fresh,
  heading,
  onEditing,
}: {
  resume: ResumeView;
  reload: Reload;
  fresh: boolean;
  /** The chosen resume's heading, where focus goes when the line whose card it held is gone. */
  heading: RefObject<HTMLHeadingElement | null>;
  onEditing?: (resumeId: string | null) => void;
}) {
  const { refreshMe } = useSession();
  const versions = useResource(() => api.resumeVersions(resume.id));
  const [version, setVersion] = useState<number | undefined>();
  // A newer version can arrive while a line editor is open. Retain the
  // rendered version until every editor closes so the user's draft survives.
  const [editing, setEditing] = useState<{ snapshot: ResumeView; ids: Set<string> } | null>(null);
  // The line whose card is open. It is the page's, so it outlives a sheet replaced by a newer version.
  const [chosen, setChosen] = useState<string | null>(null);
  const focusRequest = useRef(false);
  const latestResume = useRef(resume);
  latestResume.current = resume;
  const editingChanged = useCallback((id: string, active: boolean) => {
    const openedVersion = latestResume.current;
    setEditing((previous) => {
      if (active) {
        const ids = new Set(previous?.ids ?? []);
        ids.add(id);
        return { snapshot: previous?.snapshot ?? openedVersion, ids };
      }
      if (!previous) return null;
      const ids = new Set(previous.ids);
      ids.delete(id);
      return ids.size ? { ...previous, ids } : null;
    });
  }, []);
  const id = useId();
  const refresh = useCallback(async () => {
    await Promise.all([reload(), versions.reload()]);
  }, [reload, versions.reload]);
  const displayed = editing?.snapshot ?? resume;
  const editingOutdated = !!editing && editing.snapshot.version !== resume.version;
  const isEditing = editing !== null;
  useEffect(() => {
    if (!isEditing || !onEditing) return;
    onEditing(resume.id);
    return () => onEditing(null);
  }, [isEditing, onEditing, resume.id]);

  // A coach's suggested wordings on this person's copies, read once and again while one is being
  // checked. A server from before comments has none. When a check ends, the resume it changed is
  // read again, and so is what the allowance holds.
  const comments = useResource(
    async () => {
      try {
        return (await api.shareComments()).threads;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return [];
        throw error;
      }
    },
    (threads) => checkingIds(threads).size > 0,
  );
  const [starting, setStarting] = useState(false);
  const checking = useRef(new Set<string>());
  useEffect(() => {
    if (!comments.data) return;
    const now = checkingIds(comments.data);
    const ended = [...checking.current].some((comment) => !now.has(comment));
    checking.current = now;
    if (ended) {
      void refresh();
      void refreshMe();
    }
  }, [comments.data, refresh, refreshMe]);
  const suggestions: LineSuggestions = {
    threads: comments.data ?? [],
    error: comments.error,
    reload: comments.reload,
    busy: starting || checkingIds(comments.data ?? []).size > 0,
    onStarting: setStarting,
  };

  // A line taken away, by a removal, takes its card with it; focus goes to the resume's heading.
  useEffect(() => {
    if (version !== undefined || !chosen || !displayed.body || lineIdsOf(displayed.body).has(chosen)) return;
    setChosen(null);
    if (focusRequest.current) {
      focusRequest.current = false;
      heading.current?.focus();
    }
  }, [version, chosen, displayed, heading]);

  return (
    <>
      <div className="version-picker">
        <label htmlFor={id}>Saved version</label>
        <select
          id={id}
          value={version ?? "latest"}
          disabled={!!editing}
          onChange={(event) => {
            setChosen(null);
            setVersion(
              event.target.value === "latest"
                ? undefined
                : Number(event.target.value),
            );
          }}
        >
          <option value="latest">Latest (version {resume.version})</option>
          {(versions.data?.versions ?? [])
            .filter((saved) => saved.version !== resume.version)
            .sort((a, b) => b.version - a.version)
            .map((saved) => (
              <option key={saved.version} value={saved.version}>
                Version {saved.version}, saved {formatDateTime(saved.createdAt)}
              </option>
            ))}
        </select>
        {resume.provenance === "legacy" && (
          <span className="meta">
            Created before Resumatic saved where each line came from.
          </span>
        )}
      </div>
      {versions.error && (
        <ErrorNote message={versions.error} onRetry={versions.reload} />
      )}
      {editing && <p className="hint">Finish or cancel your line edits to change saved versions.</p>}
      {editingOutdated && <p className="notice" role="status">A newer resume version is available. Your draft is still here; copy it, then cancel the edit to view the latest version.</p>}
      {version === undefined ? (
        <>
          <ResumeSheet
            key={displayed.version}
            resume={displayed}
            body={displayed.body!}
            reload={refresh}
            onLineEditingChange={editingChanged}
            editingOutdated={editingOutdated}
            editing={!!editing}
            fresh={fresh}
            chosen={chosen}
            onChoose={setChosen}
            focusRequest={focusRequest}
            suggestions={suggestions}
          />
          <RefineWording applicationId={resume.applicationId} resume={resume} onUpdated={refresh} />
        </>
      ) : (
        <>
          <p className="notice">
            This is a saved version. Its downloads use its wording and the facts it
            was checked against, as saved. Select Latest to edit or refine.
          </p>
          <ArchivedResume
            key={`${resume.id}:${version}`}
            id={resume.id}
            version={version}
            chosen={chosen}
            onChoose={setChosen}
            focusRequest={focusRequest}
          />
          <RefineWording applicationId={resume.applicationId} onUpdated={refresh} />
        </>
      )}
    </>
  );
}

function ArchivedResume({ id, version, chosen, onChoose, focusRequest }: {
  id: string;
  version: number;
  chosen: string | null;
  onChoose: (lineId: string | null) => void;
  focusRequest: RefObject<boolean>;
}) {
  const saved = useResource(() => api.resume(id, version));
  if (saved.error)
    return <ErrorNote message={saved.error} onRetry={saved.reload} />;
  if (!saved.data) return <Loading>Loading saved version…</Loading>;
  return saved.data.body ? (
    <ResumeSheet
      resume={saved.data}
      body={saved.data.body}
      reload={saved.reload}
      readOnly
      chosen={chosen}
      onChoose={onChoose}
      focusRequest={focusRequest}
    />
  ) : (
    <ErrorNote message="This version has no saved content." />
  );
}

/**
 * Refine wording: an instruction for the latest version, and the wording checks running or failed
 * for this job, line checks and accepted suggestions among them, each with Cancel or Retry. A
 * finished one is the resume's new version, so it isn't listed here. Without `resume` (the resume
 * shown isn't a ready latest version) there is nothing to refine, but the job's wording checks are
 * still listed, so they can be stopped and tried again here; with none, nothing is shown.
 */
function RefineWording({ applicationId, resume, onUpdated }: { applicationId: string; resume?: ResumeView; onUpdated: Reload }) {
  const jobDocs = useJobDocuments(applicationId, onUpdated);
  const [instruction, setInstruction] = useState("");
  const id = useId();
  const elsewhere = runningElsewhere(jobDocs, REFINE);
  if (!resume && !jobDocs.docs.some((doc) => doc.kind === "refine" && doc.state !== "ready")) return null;
  return (
    <section className="section app-job-section app-refine" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Refine wording</h2>
      {resume && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void jobDocs.start({
              kind: "refine",
              resumeId: resume.id,
              expectedVersion: resume.version,
              instruction: instruction.trim(),
            });
          }}
        >
          <Field
            id={`${id}-instruction`}
            label={`Refine resume version ${resume.version}`}
            hint="Describe a change in wording or emphasis. A rewrite your facts don’t support keeps your current text, and an unchanged resume isn’t counted."
          >
            <textarea
              id={`${id}-instruction`}
              rows={2}
              maxLength={1000}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Make the bullets shorter, or emphasize my leadership experience."
              aria-describedby={`${id}-instruction-hint`}
            />
          </Field>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={jobDocs.action.pending || jobDocs.running || jobDocs.available === 0 || !instruction.trim()}
              aria-describedby={elsewhere ? `${id}-elsewhere` : undefined}
            >
              Refine wording
            </button>
            <span className="rs-meta">Your saved versions stay available.</span>
          </div>
        </form>
      )}
      <StartNotes id={`${id}-elsewhere`} jobDocs={jobDocs} kinds={REFINE} counted />
      <DocumentList jobDocs={jobDocs} kinds={REFINE} open="none" />
    </section>
  );
}

function TailorFailed({ resume }: { resume: ResumeView }) {
  const { tailor, pending, error } = useTailor();
  const [skillClaimIds, setSkillClaimIds] = useState<string[]>([]);

  return (
    <section className="card" aria-labelledby="failed-heading">
      <h3 id="failed-heading">This resume couldn’t be finished</h3>
      <ActionError role={null} message={resumeErrorMessage(resume.error)} />
      <p className="meta">
        Resumatic never shows lines that haven’t passed its checks, so there’s
        nothing to review from this attempt.
      </p>
      <SkillDurationChoices selected={skillClaimIds} onChange={setSkillClaimIds} disabled={pending} />
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => void tailor(resume.applicationId, skillClaimIds)}
          disabled={pending}
        >
          {pending ? "Starting…" : "Tailor again"}
        </button>
        <a className="button" href={href.jobs}>
          Back to Jobs
        </a>
      </div>
      <ActionError message={error} />
    </section>
  );
}
