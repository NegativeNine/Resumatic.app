import { useEffect, useId, useRef, useState } from "react";
import {
  MAX_LINE_CHARS,
  type FactView,
  type ResumeLine,
  type ResumeView,
} from "../../shared/api";
import { api } from "../api";
import { count, LINE_STATUS_HINT, LINE_STATUS_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { sessionEndNote, useSession } from "../session";
import { ActionError, Badge, CharCount, Quote } from "./ui";

type CitedFact = { id: string; text: string; quote: string | null };

interface Props {
  resumeId: string;
  applicationId: string;
  roleId: string | null;
  line: ResumeLine;
  facts: ResumeView["facts"];
  legacyReview?: "verified" | "pending";
  expanded: boolean;
  onToggle: (lineId: string) => void;
  reload: Reload;
  expectedVersion?: number;
  readOnly?: boolean;
}

/** One resume line, with its status and, on request, the facts and quotes it cites. */
export function LineItem({
  resumeId,
  applicationId,
  roleId,
  line,
  facts,
  legacyReview,
  expanded,
  onToggle,
  reload,
  expectedVersion,
  readOnly = false,
}: Props) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const id = useId();
  const cited: CitedFact[] = line.factIds.flatMap((factId) =>
    facts[factId] ? [{ id: factId, ...facts[factId] }] : [],
  );

  function closeEditor() {
    setEditing(false);
    ref.current?.focus();
  }

  return (
    <li className="line" ref={ref} tabIndex={-1}>
      {editing ? (
        <LineEditor
          resumeId={resumeId}
          applicationId={applicationId}
          roleId={roleId}
          line={line}
          legacyReview={!!legacyReview}
          hasEvidence={!legacyReview && cited.length > 0 && cited.length === line.factIds.length &&
            cited.every((fact) => !!fact.text.trim()) && ["kept", "repaired", "replaced"].includes(line.status)}
          reload={reload}
          onClose={closeEditor}
          expectedVersion={expectedVersion}
        />
      ) : (
        <p className="line-text" id={`${id}-text`}>
          {line.text}
        </p>
      )}
      <div className="line-tools">
        <Badge tone={legacyReview === "pending" ? "edited" : line.status} title={legacyReview === "pending" ? "This older line needs a fresh check against confirmed facts." : LINE_STATUS_HINT[line.status]}>
          {legacyReview === "pending" ? "Needs review" : legacyReview === "verified" ? "Checked" : LINE_STATUS_LABEL[line.status]}
        </Badge>
        <button
          type="button"
          className="link-button"
          aria-expanded={expanded}
          aria-controls={`${id}-evidence`}
          aria-describedby={editing ? undefined : `${id}-text`}
          onClick={() => onToggle(line.id)}
        >
          {legacyReview === "pending"
            ? expanded ? "Hide review note" : "Show review note"
            : expanded ? "Hide evidence" : `Show evidence (${count(cited.length, "fact")})`}
        </button>
        {!editing && !readOnly && (
          <button
            type="button"
            className="link-button"
            aria-describedby={`${id}-text`}
            onClick={() => setEditing(true)}
          >
            {legacyReview === "pending" ? "Review line" : "Edit line"}
          </button>
        )}
      </div>
      <div className="evidence" id={`${id}-evidence`} hidden={!expanded}>
        {legacyReview === "pending"
          ? <p className="meta">This older line's citations have not been rechecked. Select confirmed facts when reviewing it.</p>
          : <Evidence facts={cited} />}
      </div>
    </li>
  );
}

function Evidence({ facts }: { facts: CitedFact[] }) {
  if (facts.length === 0)
    return <p className="meta">This line doesn't cite any facts.</p>;
  return (
    <ul className="plain-list">
      {facts.map((fact) => (
        <li key={fact.id} className="evidence-item">
          <p className="evidence-label">Fact</p>
          <p>{fact.text}</p>
          {fact.quote ? (
            <Quote text={fact.quote} caption="The words it came from" />
          ) : (
            <p className="meta">Your own claim, with no source quote.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function LineEditor({
  resumeId,
  applicationId,
  roleId,
  line,
  hasEvidence,
  legacyReview,
  reload,
  onClose,
  expectedVersion,
}: {
  resumeId: string;
  applicationId: string;
  roleId: string | null;
  line: ResumeLine;
  hasEvidence: boolean;
  legacyReview: boolean;
  reload: Reload;
  onClose: () => void;
  expectedVersion?: number;
}) {
  const [text, setText] = useState(line.text);
  const { run, pending, error, setError } = useAction();
  const { endSession, refreshMe } = useSession();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [checkingMessage, setCheckingMessage] = useState<string | null>(null);
  const [availableFacts, setAvailableFacts] = useState<FactView[] | null>(null);
  const [factsError, setFactsError] = useState(false);
  const [selectedFacts, setSelectedFacts] = useState<ReadonlySet<string>>(() => new Set());
  const id = useId();
  const trimmed = text.trim();

  useEffect(() => {
    if (hasEvidence) return;
    let stopped = false;
    api.facts("confirmed").then(({ facts }) => {
      if (!stopped) setAvailableFacts(facts.filter((fact) => roleId === null || fact.roleId === roleId));
    }).catch((e) => {
      if (stopped) return;
      const note = sessionEndNote(e);
      if (note) endSession(note); else setFactsError(true);
    });
    return () => { stopped = true; };
  }, [endSession, hasEvidence, roleId]);

  useEffect(() => {
    if (!documentId) return;
    let stopped = false;
    let timer: number | undefined;
    async function check() {
      try {
        const doc = await api.document(documentId!);
        if (stopped) return;
        if (doc.state === "ready") {
          await reload();
          if (!stopped) onClose();
          void refreshMe();
          return;
        }
        if (doc.state === "failed") {
          setDocumentId(null);
          setCheckingMessage(null);
          setError(doc.error === "conflict"
            ? "The resume or its facts changed. Refresh the resume, then try your edit again."
            : "We couldn't verify that wording against its evidence. Confirm or add the relevant facts, then try again.");
          void refreshMe();
          return;
        }
        setCheckingMessage(doc.dispatchUncertain
          ? "Your check was requested, but we can't yet confirm it started. Please keep this page open."
          : "Checking your wording against the cited facts…");
      } catch (e) {
        if (stopped) return;
        const note = sessionEndNote(e);
        if (note) { endSession(note); return; }
        setCheckingMessage("We couldn't check the status. We'll keep trying; your wording is still here.");
      }
      if (!stopped) timer = window.setTimeout(check, 2000);
    }
    void check();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [documentId, endSession, onClose, refreshMe, reload, setError]);

  async function save() {
    const ok = await run(async () => {
      const started = await api.startDocument(applicationId, {
        kind: "refine", resumeId, expectedVersion, lineIds: [line.id], manualText: trimmed,
        ...(!hasEvidence ? { manualFactIds: [...selectedFacts] } : {}),
      });
      setDocumentId(started.documentId);
      setCheckingMessage("Checking your wording against the cited facts…");
      void refreshMe();
    });
    if (!ok) setCheckingMessage(null);
  }

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>Line</label>
      <textarea
        id={id}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!!documentId}
        aria-describedby={`${id}-note ${id}-count`}
        autoFocus
      />
      <CharCount
        id={`${id}-count`}
        length={trimmed.length}
        max={MAX_LINE_CHARS}
      />
      <p className="hint" id={`${id}-note`}>
        {hasEvidence
          ? "Your wording is checked against the cited facts before it replaces this line. A completed check uses one output."
          : legacyReview
            ? "Choose up to four confirmed facts that support this older line. You can check its current wording or change it. The check uses one output."
            : "This line has no verified citations. Choose up to four confirmed facts that support it. The check uses one output."}
      </p>
      {!hasEvidence && (
        <fieldset disabled={pending || !!documentId}>
          <legend>Supporting facts{roleId ? " for this role" : ""}</legend>
          {factsError && <p className="alert" role="alert">We couldn't load confirmed facts. Close this editor and try again.</p>}
          {!factsError && availableFacts === null && <p className="meta">Loading confirmed facts…</p>}
          {availableFacts?.length === 0 && <p className="meta">No confirmed facts are available for this line. Add or confirm a relevant fact in Sources &amp; facts first.</p>}
          {availableFacts?.map((fact) => (
            <label key={fact.id}>
              <input type="checkbox" checked={selectedFacts.has(fact.id)}
                disabled={!selectedFacts.has(fact.id) && selectedFacts.size >= 4}
                onChange={() => setSelectedFacts((previous) => {
                  const next = new Set(previous);
                  if (!next.delete(fact.id)) next.add(fact.id);
                  return next;
                })} />{" "}{fact.text}
            </label>
          ))}
        </fieldset>
      )}
      {checkingMessage && <p className="hint" role="status">{checkingMessage}</p>}
      <div className="actions">
        <button
          type="submit"
          className="primary small"
          disabled={
            pending || !!documentId || (!hasEvidence && selectedFacts.size === 0) ||
            !trimmed ||
            trimmed.length > MAX_LINE_CHARS ||
            (hasEvidence && trimmed === line.text)
          }
        >
          {pending ? "Starting…" : documentId ? "Checking…" : "Check and save"}
        </button>
        <button
          type="button"
          className="small"
          onClick={onClose}
          disabled={pending || !!documentId}
        >
          Cancel
        </button>
      </div>
      <ActionError message={error} />
    </form>
  );
}
