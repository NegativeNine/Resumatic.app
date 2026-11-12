import { useEffect, useId, useRef, useState } from "react";
import {
  MAX_FACT_CHARS,
  type ResumeView,
  type RoleView,
} from "../../shared/api";
import type {
  DocumentKind,
  DocumentView,
  NewDocument,
} from "../../shared/documents";
import { api } from "../api";
import { count, formatDateTime } from "../format";
import { forgetDocumentStart, readDocumentStart, rememberDocumentStart } from "../document-starts";
import { useAction, useResource, type Reload } from "../hooks";
import { useSession } from "../session";
import { roleLabel } from "../vault";
import {
  ActionError,
  Badge,
  CharCount,
  ErrorNote,
  Field,
  Glyph,
  Loading,
  Message,
  Quote,
  RUN_MARK,
  Success,
  Tick,
} from "./ui";
import "./workspace.css";

const LABELS: Record<DocumentKind, string> = {
  letter: "Cover letter",
  prep: "Interview preparation",
  questions: "Experience questions",
  refine: "Resume refinement",
  fit: "Fit preview",
};

/** Kinds that aren't counted as documents, so they stay available when the allowance is used up. */
const FREE: readonly DocumentKind[] = ["questions", "fit"];

type ApplicationDocumentsProps = {
  applicationId: string;
  resume?: ResumeView;
  onUpdated?: Reload;
  /** On the resume page the section stands alone, so it gets its own panel. */
  panel?: boolean;
};

export function ApplicationDocuments(props: ApplicationDocumentsProps) {
  const { me } = useSession();
  return <ApplicationDocumentsForUser key={JSON.stringify([me.userId, props.applicationId])} {...props} />;
}

function ApplicationDocumentsForUser({
  applicationId,
  resume,
  onUpdated,
  panel = false,
}: ApplicationDocumentsProps) {
  const list = useResource(
    () => api.documents(applicationId),
    (data) => data.documents.some((doc) => doc.state === "running"),
  );
  const { me, refreshMe } = useSession();
  const action = useAction();
  const requested = useRef(new Set<string>());
  const seenStates = useRef(new Map<string, DocumentView["state"]>());
  const callbacks = useRef({ onUpdated, refreshMe });
  callbacks.current = { onUpdated, refreshMe };
  const [instruction, setInstruction] = useState("");
  // A successful start can be followed by a failed or superseded list read.
  // Keep generation disabled until the acknowledged document appears.
  const [unseenDocument, setUnseenDocument] = useState<string | null>(() => readDocumentStart(me.userId, applicationId));
  const id = useId();
  const docs = list.data?.documents ?? [];
  const running = !list.data || !!list.error || !!unseenDocument || docs.some((doc) => doc.state === "running");
  const available = Math.max(
    0,
    me.quota.limit - me.quota.used - (me.quota.reserved ?? 0),
  );

  useEffect(() => {
    for (const doc of list.data?.documents ?? []) {
      if (
        doc.state !== "running" &&
        (requested.current.delete(doc.id) ||
          seenStates.current.get(doc.id) === "running")
      ) {
        void callbacks.current.refreshMe();
        if (doc.kind === "refine" && doc.state === "ready")
          void callbacks.current.onUpdated?.();
      }
    }
    seenStates.current = new Map(
      (list.data?.documents ?? []).map((doc) => [doc.id, doc.state]),
    );
  }, [list.data]);

  useEffect(() => {
    if (unseenDocument && list.data?.documents.some((doc) => doc.id === unseenDocument)) {
      forgetDocumentStart(me.userId, applicationId, unseenDocument);
      setUnseenDocument(null);
    }
  }, [list.data, unseenDocument, me.userId, applicationId]);

  async function start(options: NewDocument) {
    await action.run(async () => {
      const { documentId } = await api.startDocument(applicationId, options);
      requested.current.add(documentId);
      rememberDocumentStart(me.userId, applicationId, documentId);
      setUnseenDocument(documentId);
      await list.reload();
      void refreshMe();
    });
  }

  async function retry(runId: string) {
    await action.run(async () => {
      const { targetId } = await api.retryRun(runId);
      requested.current.add(targetId);
      rememberDocumentStart(me.userId, applicationId, targetId);
      setUnseenDocument(targetId);
      await list.reload();
      void refreshMe();
    });
  }

  return (
    <section className={panel ? "rs-panel app-documents" : "workspace-section app-documents"} aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Prepare your application</h3>
      <p className="rs-meta">
        Letters and interview answers are written from your confirmed facts. Each finished one counts as one
        document. Checking your fit and experience questions are free.
      </p>
      <div className="actions app-documents__start">
        <button
          type="button"
          onClick={() => void start({ kind: "fit" })}
          disabled={action.pending || running}
        >
          Check your fit
        </button>
        <button
          type="button"
          onClick={() => void start({ kind: "letter" })}
          disabled={action.pending || running || available === 0}
        >
          Create cover letter
        </button>
        <button
          type="button"
          onClick={() => void start({ kind: "prep" })}
          disabled={action.pending || running || available === 0}
        >
          Prepare for an interview
        </button>
        <button
          type="button"
          onClick={() => void start({ kind: "questions" })}
          disabled={action.pending || running}
        >
          Find missing experience
        </button>
      </div>
      {available === 0 && (
        <Message tone="info" live={false}>
          Your documents for this period are used or held for work in progress. You can still read your documents
          and answer experience questions.
        </Message>
      )}
      {resume?.state === "ready" && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void start({
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
              disabled={
                action.pending ||
                running ||
                available === 0 ||
                !instruction.trim()
              }
            >
              Refine wording
            </button>
            <span className="rs-meta">Your saved versions stay available.</span>
          </div>
        </form>
      )}
      <ActionError message={action.error} />
      {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
      {unseenDocument && !list.error && (
        <p className="rs-meta" role="status">
          Your document was started. <button type="button" className="rs-linkbtn" onClick={() => void list.reload()}>Refresh its status</button> before starting another.
        </p>
      )}
      {!list.data && !list.error && <Loading>Loading your documents…</Loading>}
      {docs.length > 0 && (
        <ul className="plain-list document-list">
          {docs.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              reload={list.reload}
              retry={retry}
              retryDisabled={action.pending || running || (available === 0 && !FREE.includes(doc.kind))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DocumentCard({ doc, reload, retry, retryDisabled }: {
  doc: DocumentView;
  reload: Reload;
  retry: (runId: string) => Promise<void>;
  retryDisabled: boolean;
}) {
  const cancel = useAction();
  return (
    <li className="document-card">
      <div className="app-doc-head">
        <div>
          <h4>{LABELS[doc.kind]}</h4>
          <p className="rs-meta">{formatDateTime(doc.createdAt)}</p>
        </div>
        <Badge tone={RUN_MARK[doc.state]}>
          {doc.state === "ready" && <Glyph name="check" />}
          {doc.state === "failed" && <Glyph name="alert" />}
          {doc.state === "running"
            ? doc.cancellationPending ? "Cancellation pending" : doc.dispatchUncertain ? "Start unconfirmed" : "Preparing"
            : doc.state === "ready"
              ? "Ready"
              : "Not finished"}
        </Badge>
      </div>
      {doc.state === "running" && doc.cancellationPending && (
        <p className="rs-meta" role="status">
          Cancellation is pending. Preparation may still start or carry on for a moment, so check back soon.
        </p>
      )}
      {doc.state === "running" && doc.dispatchUncertain && !doc.cancellationPending && (
        <p className="rs-meta" role="status">
          Your request was saved, but Resumatic can’t confirm that preparation started.
          It may still begin, so check back soon.
        </p>
      )}
      {doc.state === "running" && !doc.cancellationPending && (
        <div className="app-doc-running">
          {!doc.dispatchUncertain && <Loading>Preparing and checking your document…</Loading>}
          <button
            type="button"
            className="small"
            disabled={cancel.pending}
            onClick={() =>
              void cancel.run(async () => {
                await api.cancelRun(doc.id);
                await reload();
              })
            }
          >
            {cancel.pending ? "Stopping…" : "Cancel generation"}
          </button>
          <ActionError message={cancel.error} />
        </div>
      )}
      {doc.state === "failed" && (
        <div className="rs-msg rs-msg--error app-doc-failed" role="status">
          <Glyph name="alert" />
          <p className="rs-msg__text">{documentError(doc.error)}</p>
          {doc.retryRunId && (
            <button type="button" className="rs-btn rs-btn--sm" disabled={retryDisabled} onClick={() => void retry(doc.retryRunId!)}>
              Retry {LABELS[doc.kind].toLowerCase()}
            </button>
          )}
        </div>
      )}
      {doc.state === "ready" && doc.result && (
        <details className="document-detail">
          <summary>Read {LABELS[doc.kind].toLowerCase()}</summary>
          <DocumentContent doc={doc} />
        </details>
      )}
    </li>
  );
}

function DocumentContent({ doc }: { doc: DocumentView }) {
  const result = doc.result!;
  if (doc.kind === "questions")
    return <GapQuestions documentId={doc.id} questions={result.questions} answeredQuestionIds={doc.answeredQuestionIds ?? []} />;
  if (doc.kind === "fit") return <FitPreview doc={doc} />;
  const groups = [...new Set(result.units.map((unit) => unit.group))].sort(
    (a, b) => a - b,
  );
  return (
    <div className="document-content">
      {doc.kind === "refine" && (
        <p className="rs-meta">
          The current resume was updated wherever your facts supported an improvement. Earlier versions stay in
          its version history.
        </p>
      )}
      {/* What gets sent is shown on white paper, like the resume. */}
      <div className="app-letter">
        {doc.kind === "prep"
          ? result.questions.map((question, index) => (
              <section key={`${index}-${question.requirement}`}>
                <h4>{question.question}</h4>
                {result.units.some((unit) => unit.group === index) ? (
                  <ul>
                    {result.units
                      .filter((unit) => unit.group === index)
                      .map((unit) => (
                        <li key={unit.id}>{unit.text}</li>
                      ))}
                  </ul>
                ) : (
                  <p className="app-letter__none">
                    Your selected facts don’t support an answer yet. Use a true example from your experience, or
                    say that this is something you’re still learning.
                  </p>
                )}
              </section>
            ))
          : groups.map((group) => (
              <p key={group}>
                {result.units
                  .filter((unit) => unit.group === group)
                  .map((unit) => unit.text)
                  .join(" ")}
              </p>
            ))}
      </div>
      <DocumentDownload doc={doc} />
      <details className="evidence">
        <summary>Where these sentences came from</summary>
        <ul className="plain-list app-doc-evidence">
          {result.units.map((unit) => (
            <li className="evidence-item" key={unit.id}>
              <p className="app-doc-evidence__text">{unit.text}</p>
              {unit.status === "edited" && (
                <p className="rs-meta">Your own wording.</p>
              )}
              {unit.factIds.map((factId) => {
                const fact = doc.facts[factId];
                return fact ? (
                  <div className="rs-note__fact" key={factId}>
                    <p className="rs-meta">Fact</p>
                    <p>{fact.text}</p>
                    {fact.quote ? (
                      <Quote text={fact.quote} size="sm" />
                    ) : (
                      <p className="rs-meta">Added by you, with no quote from a file.</p>
                    )}
                  </div>
                ) : null;
              })}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * How the posting's requirements stand against confirmed facts. Nothing here is written by a
 * model: the requirements are read from the posting, and the facts are the person's own.
 */
function FitPreview({ doc }: { doc: DocumentView }) {
  const requirements = doc.result?.fit?.requirements ?? [];
  const covered = requirements.filter((requirement) => requirement.factIds.length > 0).length;
  if (requirements.length === 0)
    return (
      <div className="document-content">
        <p className="rs-meta">No requirements could be read from this posting. Check that the whole posting was pasted.</p>
      </div>
    );
  return (
    <div className="document-content">
      <p className="app-fit__summary">
        Your confirmed facts cover {covered} of {count(requirements.length, "requirement")}.
      </p>
      <ul className="plain-list app-fit">
        {requirements.map((requirement, index) => {
          const facts = requirement.factIds.map((id) => doc.facts[id]).filter((fact) => fact !== undefined);
          return (
            <li key={`${index}-${requirement.text}`}>
              <Tick state={facts.length > 0 ? "backed" : "todo"} />
              <div>
                <p className="app-fit__req">
                  {requirement.text}
                  {facts.length === 0 && <span className="rs-meta"> Not in your record</span>}
                </p>
                {facts.map((fact, i) => (
                  <p className="rs-meta app-fit__fact" key={i}>
                    <Glyph name="quote" />
                    {fact.text}
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="rs-meta">
        Resumatic never fills in what’s missing for you. If you have the experience, add it with Find missing
        experience, or under Facts.
      </p>
    </div>
  );
}

function DocumentDownload({ doc }: { doc: DocumentView }) {
  const [copied, setCopied] = useState(false);
  const copy = useAction();
  const result = doc.result!;
  const text =
    doc.kind === "prep"
      ? result.questions
          .map((q, i) =>
            [
              q.question,
              ...result.units
                .filter((u) => u.group === i)
                .map((u) => `- ${u.text}`),
            ].join("\n"),
          )
          .join("\n\n")
      : [...new Set(result.units.map((u) => u.group))]
          .sort((a, b) => a - b)
          .map((group) =>
            result.units
              .filter((u) => u.group === group)
              .map((u) => u.text)
              .join(" "),
          )
          .join("\n\n");
  function download() {
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${doc.kind}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div>
      <div className="actions">
        {(doc.kind === "letter" || doc.kind === "prep") && (
          <a
            className="rs-btn rs-btn--sm"
            href={api.documentDocxUrl(doc.id)}
            download={doc.kind === "letter" ? "cover-letter.docx" : "interview-preparation.docx"}
            referrerPolicy="no-referrer"
          >
            <Glyph name="download" />
            Download Word
          </a>
        )}
        <button type="button" className="small" onClick={download}>
          Download text
        </button>
        <button
          type="button"
          className="small"
          disabled={copy.pending}
          onClick={() =>
            void copy.run(async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            })
          }
        >
          Copy text
        </button>
        {copied && <Success>Copied.</Success>}
      </div>
      <ActionError message={copy.error} />
    </div>
  );
}

function GapQuestions({
  documentId,
  questions,
  answeredQuestionIds,
}: {
  documentId: string;
  questions: NonNullable<DocumentView["result"]>["questions"];
  answeredQuestionIds: string[];
}) {
  const roles = useResource(api.roles);
  if (!questions.length)
    return (
      <Success>Nothing missing was found in the requirements that were checked.</Success>
    );
  return (
    <div className="document-content stack">
      <p className="rs-meta">
        Answer only from your own experience. Saving an answer adds your words to your facts as a confirmed
        fact.
      </p>
      {roles.error && (
        <ErrorNote message={roles.error} onRetry={roles.reload} />
      )}
      {questions.map((question, index) => (
        <GapAnswer
          key={`${index}-${question.requirement}`}
          documentId={documentId}
          questionId={question.id}
          question={question.question}
          previouslyAnswered={answeredQuestionIds.includes(question.id)}
          roles={roles.data?.roles ?? []}
        />
      ))}
    </div>
  );
}

function GapAnswer({
  documentId,
  questionId,
  question,
  previouslyAnswered,
  roles,
}: {
  documentId: string;
  questionId: string;
  question: string;
  previouslyAnswered: boolean;
  roles: RoleView[];
}) {
  const [answer, setAnswer] = useState("");
  const [roleId, setRoleId] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const id = useId();
  return (
    <form
      className="gap-answer"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await api.answerInterview(documentId, questionId, {
            roleId: roleId || null,
            answer: answer.trim(),
          });
          setSaved(true);
        });
      }}
    >
      {previouslyAnswered && <p className="rs-meta">You’ve already saved an answer to this question. You can add another.</p>}
      <Field id={`${id}-answer`} label={question}>
        <textarea
          id={`${id}-answer`}
          rows={3}
          maxLength={MAX_FACT_CHARS}
          value={answer}
          disabled={action.pending || saved}
          onChange={(event) => setAnswer(event.target.value)}
          aria-describedby={`${id}-count`}
        />
      </Field>
      <CharCount
        id={`${id}-count`}
        length={answer.trim().length}
        max={MAX_FACT_CHARS}
      />
      <Field id={`${id}-role`} label="Which role does this describe?">
        <select
          id={`${id}-role`}
          value={roleId}
          disabled={action.pending || saved}
          onChange={(event) => setRoleId(event.target.value)}
        >
          <option value="">General experience</option>
          {roles
            .filter((role) => role.state === "confirmed")
            .map((role) => (
              <option key={role.id} value={role.id}>
                {roleLabel(role)}
              </option>
            ))}
        </select>
      </Field>
      <div className="actions">
        <button
          type="submit"
          className="small primary"
          disabled={action.pending || saved || !answer.trim()}
        >
          {saved
            ? "Saved to your facts"
            : action.pending
              ? "Saving…"
              : "Save my answer as a fact"}
        </button>
      </div>
      {saved && <Success>Saved. Create a new document to use this experience.</Success>}
      <ActionError message={action.error} />
    </form>
  );
}

function documentError(code: string | null): string {
  if (code === "conflict")
    return "The resume or facts changed while this document was being prepared. Review the current version, then try again.";
  if (code === "quota")
    return "This document stopped at a usage limit, so it isn’t counted toward your documents.";
  if (code === "invalid")
    return "Your confirmed facts aren’t enough to finish this document. Confirm the facts it needs, then try again.";
  return "This document couldn’t be finished, so it isn’t counted toward your documents. Try again with the buttons above.";
}
