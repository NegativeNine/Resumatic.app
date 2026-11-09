import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  MAX_LINE_CHARS,
  type FactView,
  type ResumeLine,
  type ResumeView,
} from "../../shared/api";
import { presentResumeBullet } from "../../shared/resume-presentation";
import { api } from "../api";
import { count, findingSentence, LINE_STATUS_HINT, LINE_STATUS_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { sessionEndNote, useSession } from "../session";
import { ActionError, Badge, CharCount, Glyph, Quote } from "./ui";

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
  canRemove?: boolean;
  onEditingChange?: (id: string, active: boolean) => void;
  editingOutdated?: boolean;
}

/**
 * A resume line's note in the margin (ResumeLine): its status, a toggle for the facts and quotes
 * it cites, and its tools. The line itself prints on the sheet (ResumePaper); the note repeats
 * its words only on narrow screens, where the notes follow the sheet as a list.
 */
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
  canRemove = false,
  onEditingChange,
  editingOutdated = false,
}: Props) {
  const [editing, setEditing] = useState(false);
  const removal = useAction();
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const cited: CitedFact[] = line.factIds.flatMap((factId) =>
    facts[factId] ? [{ id: factId, ...facts[factId] }] : [],
  );

  const closeEditor = useCallback(() => {
    setEditing(false);
    onEditingChange?.(line.id, false);
    ref.current?.focus();
  }, [line.id, onEditingChange]);

  return (
    <div className={expanded ? "rs-note is-open" : "rs-note"} ref={ref} tabIndex={-1} data-note-for={line.id}>
      <div className="rs-note__row rs-note__head">
        <Badge tone={legacyReview === "pending" ? "edited" : line.status} title={legacyReview === "pending" ? "This older line needs a fresh check against confirmed facts." : LINE_STATUS_HINT[line.status]}>
          {legacyReview === "pending" ? "Needs review" : legacyReview === "verified" ? "Checked" : LINE_STATUS_LABEL[line.status]}
        </Badge>
        <button
          type="button"
          className="rs-note__toggle"
          aria-expanded={expanded}
          aria-controls={`${id}-evidence`}
          aria-describedby={`${id}-text`}
          onClick={() => onToggle(line.id)}
        >
          <Glyph name="follows" />
          <span>
            {legacyReview === "pending"
              ? expanded ? "Hide review note" : "Review note"
              : expanded ? "Hide evidence" : count(cited.length, "fact")}
          </span>
        </button>
      </div>
      <p className="rs-note__line" id={`${id}-text`}>
        {roleId === null ? line.text : presentResumeBullet(line.text)}
      </p>
      {editing && (
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
          editingOutdated={editingOutdated}
        />
      )}
      <div className="rs-note__evidence" id={`${id}-evidence`} hidden={!expanded}>
        {!legacyReview && line.finding && (line.status === "repaired" || line.status === "replaced") && (
          <p className="rs-meta">{findingSentence(line.finding, line.status)}</p>
        )}
        {legacyReview === "pending"
          ? <p className="rs-meta">This older line’s citations haven’t been rechecked. Select confirmed facts when reviewing it.</p>
          : <Evidence facts={cited} />}
        {!editing && !readOnly && (
          <div className="rs-note__row">
            <button
              type="button"
              className="rs-linkbtn"
              aria-describedby={`${id}-text`}
              onClick={() => { onEditingChange?.(line.id, true); setEditing(true); }}
            >
              {legacyReview === "pending" ? "Review line" : "Edit line"}
            </button>
            {(legacyReview || canRemove) && expectedVersion !== undefined && (
              <button type="button" className="rs-linkbtn" disabled={removal.pending} aria-describedby={`${id}-text`}
                onClick={() => void removal.run(async () => {
                  if (legacyReview) await api.removeLegacyLine(resumeId, line.id, expectedVersion);
                  else await api.removeResumeLine(resumeId, line.id, expectedVersion);
                  await reload();
                })}>
                {removal.pending ? "Removing…" : "Remove line (keeps earlier versions)"}
              </button>
            )}
          </div>
        )}
      </div>
      <ActionError message={removal.error} />
    </div>
  );
}

function Evidence({ facts }: { facts: CitedFact[] }) {
  if (facts.length === 0)
    return <p className="rs-meta">This line doesn’t cite any facts.</p>;
  return (
    <>
      {facts.map((fact) => (
        <div key={fact.id} className="rs-note__fact">
          <p className="rs-note__label">Fact</p>
          <p className="rs-note__fact-text">{presentResumeBullet(fact.text)}</p>
          {fact.quote ? (
            <Quote text={fact.quote} size="sm" caption="The words it came from" />
          ) : (
            <p className="rs-meta">Your own claim, with no source quote.</p>
          )}
        </div>
      ))}
    </>
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
  editingOutdated,
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
  editingOutdated: boolean;
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
            : "That wording couldn’t be verified against its evidence. Confirm or add the facts it needs, then try again.");
          void refreshMe();
          return;
        }
        setCheckingMessage(doc.dispatchUncertain
          ? "Your check was requested, but Resumatic can’t confirm yet that it started. Keep this page open."
          : "Checking your wording against the cited facts…");
      } catch (e) {
        if (stopped) return;
        const note = sessionEndNote(e);
        if (note) { endSession(note); return; }
        setCheckingMessage("The check’s status couldn’t be loaded. Resumatic will keep trying, and your wording is still here.");
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
        disabled={pending || !!documentId}
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
          {factsError && <p className="alert" role="alert">Your confirmed facts couldn’t be loaded. Close this editor, then try again.</p>}
          {!factsError && availableFacts === null && <p className="meta">Loading confirmed facts…</p>}
          {availableFacts?.length === 0 && <p className="meta">No confirmed facts are available for this line. Add or confirm a relevant fact under Facts first.</p>}
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
            pending || !!documentId || editingOutdated || (!hasEvidence && selectedFacts.size === 0) ||
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
