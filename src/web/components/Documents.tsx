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
import { formatDateTime } from "../format";
import { useAction, useResource, type Reload } from "../hooks";
import { useSession } from "../session";
import { roleLabel } from "../vault";
import {
  ActionError,
  Badge,
  CharCount,
  ErrorNote,
  Field,
  Loading,
  Quote,
} from "./ui";
import "./workspace.css";

const LABELS: Record<DocumentKind, string> = {
  letter: "Cover letter",
  prep: "Interview preparation",
  questions: "Experience questions",
  refine: "Resume refinement",
};

export function ApplicationDocuments({
  applicationId,
  resume,
  onUpdated,
}: {
  applicationId: string;
  resume?: ResumeView;
  onUpdated?: Reload;
}) {
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
  const id = useId();
  const docs = list.data?.documents ?? [];
  const running = docs.some((doc) => doc.state === "running");
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

  async function start(options: NewDocument) {
    await action.run(async () => {
      const { documentId } = await api.startDocument(applicationId, options);
      requested.current.add(documentId);
      await list.reload();
      void refreshMe();
    });
  }

  async function retry(runId: string) {
    await action.run(async () => {
      const { targetId } = await api.retryRun(runId);
      requested.current.add(targetId);
      await list.reload();
      void refreshMe();
    });
  }

  return (
    <section className="workspace-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Prepare your application</h3>
      <p className="hint">
        Letters and interview answers use confirmed facts. Each completed new
        document uses one output; experience questions are free.
      </p>
      <div className="actions">
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
        <p className="hint">
          Your available output allowance is used or reserved. You can still
          review documents and answer experience questions.
        </p>
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
            hint="Describe a change in wording or emphasis. Unsupported rewrites keep your current text; an unchanged resume uses no output."
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
            <span className="meta">Your saved versions remain available.</span>
          </div>
        </form>
      )}
      <ActionError message={action.error} />
      {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading>Loading your documents…</Loading>}
      {docs.length > 0 && (
        <ul className="plain-list document-list">
          {docs.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              reload={list.reload}
              retry={retry}
              retryDisabled={action.pending || running || (available === 0 && doc.kind !== "questions")}
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
      <div className="row-between">
        <div>
          <h4>{LABELS[doc.kind]}</h4>
          <p className="meta">{formatDateTime(doc.createdAt)}</p>
        </div>
        <Badge tone={doc.state}>
          {doc.state === "running"
            ? doc.cancellationPending ? "Cancellation pending" : doc.dispatchUncertain ? "Start unconfirmed" : "Preparing"
            : doc.state === "ready"
              ? "Ready"
              : "Not completed"}
        </Badge>
      </div>
      {doc.state === "running" && doc.cancellationPending && (
        <p role="status">
          Cancellation is pending. Preparation may still start or continue; please check back.
        </p>
      )}
      {doc.state === "running" && doc.dispatchUncertain && !doc.cancellationPending && (
        <p role="status">
          Your request was saved, but we can't confirm that preparation started.
          It may still begin; please check back.
        </p>
      )}
      {doc.state === "running" && !doc.cancellationPending && (
        <>
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
        </>
      )}
      {doc.state === "failed" && (
        <div>
          <p className="alert" role="status">{documentError(doc.error)}</p>
          {doc.retryRunId && (
            <button type="button" className="small" disabled={retryDisabled} onClick={() => void retry(doc.retryRunId!)}>
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
    return <GapQuestions documentId={doc.id} questions={result.questions} />;
  const groups = [...new Set(result.units.map((unit) => unit.group))].sort(
    (a, b) => a - b,
  );
  return (
    <div className="document-content stack">
      {doc.kind === "refine" && (
        <p className="hint">
          The current resume has been updated where a supported improvement was
          found. Earlier versions remain in its version history.
        </p>
      )}
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
                <p className="hint">
                  No answer is supported by the selected facts yet. Use a true
                  example from your experience, or explain that this is an area
                  you are still learning.
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
      <DocumentDownload doc={doc} />
      <details className="evidence">
        <summary>Evidence behind these sentences</summary>
        <ul className="plain-list">
          {result.units.map((unit) => (
            <li className="evidence-item" key={unit.id}>
              <p>{unit.text}</p>
              {unit.status === "edited" && (
                <p className="hint">Your own wording.</p>
              )}
              {unit.factIds.map((factId) => {
                const fact = doc.facts[factId];
                return fact ? (
                  <div key={factId}>
                    <p className="evidence-label">Confirmed fact</p>
                    <p>{fact.text}</p>
                    {fact.quote && (
                      <Quote text={fact.quote} caption="Source evidence" />
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
        {copied && (
          <span className="success inline" role="status">
            Copied.
          </span>
        )}
      </div>
      <ActionError message={copy.error} />
    </div>
  );
}

function GapQuestions({
  documentId,
  questions,
}: {
  documentId: string;
  questions: NonNullable<DocumentView["result"]>["questions"];
}) {
  const roles = useResource(api.roles);
  if (!questions.length)
    return (
      <p className="success">
        No gaps were identified in the selected requirements.
      </p>
    );
  return (
    <div className="document-content stack">
      <p className="hint">
        Answer only from your own experience. Saving an answer adds your words
        as a confirmed fact in your Career Vault.
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
  roles,
}: {
  documentId: string;
  questionId: string;
  question: string;
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
      <Field id={`${id}-answer`} label={question}>
        <textarea
          id={`${id}-answer`}
          rows={3}
          maxLength={MAX_FACT_CHARS}
          value={answer}
          disabled={saved}
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
          disabled={saved}
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
            ? "Saved to your vault"
            : action.pending
              ? "Saving…"
              : "Save my answer as a fact"}
        </button>
      </div>
      {saved && (
        <p className="success" role="status">
          Saved. Generate a new document to use this experience.
        </p>
      )}
      <ActionError message={action.error} />
    </form>
  );
}

function documentError(code: string | null): string {
  if (code === "conflict")
    return "The resume or facts changed while this document was being prepared. Review the current version, then try again.";
  if (code === "quota")
    return "Generation stopped at the configured limit. Your output allowance was released.";
  if (code === "invalid")
    return "There was not enough usable evidence to finish this document. Confirm relevant facts and try again.";
  return "This document could not be completed. Your output allowance was released; you can try again from the controls above.";
}
