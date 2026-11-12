import { useEffect, useId, useState } from "react";
import {
  KIT_PROBLEMS,
  MAX_KIT_ANSWER_CHARS,
  MAX_KIT_QUESTIONS,
  MAX_SAVED_LABEL_CHARS,
  SENSITIVE_KIND_WORDS,
  type KitAnswerChange,
  type KitChoice,
  type KitPart,
  type KitQuestionView,
  type KitView,
  type SavedAnswer,
} from "../../shared/kit";
import { api, ApiError } from "../api";
import { formatDate, typeset } from "../format";
import { useAction, useResource, type Action } from "../hooks";
import { kitWriteObserved, type KitWrite } from "../kit-save";
import { ActionError, Badge, ErrorNote, Field, Glyph, Loading, Quote } from "./ui";

// The Application kit panel in a job's workspace: a resume version, a letter and preparation if
// wanted, and the person's answers to the employer's questions, put together and approved here and
// downloaded to be sent by the person themselves. Nothing is sent from here.
//
// An employer's questions are someone else's text: they are shown in a quote, as text. Every write
// names the revision the panel read; a reply that is lost is accepted only if a fresh read shows the
// kit at the next revision holding what was sent.

/** Ends the session, rather than being settled by a fresh read. */
const ending = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 410);
const partKey = (part: KitPart | null) => (part ? `${part.id}:${part.version}` : "");
const fromKey = (key: string): KitPart | null => {
  if (!key) return null;
  const at = key.lastIndexOf(":");
  return { id: key.slice(0, at), version: Number(key.slice(at + 1)) };
};

export function ApplicationKit({ applicationId }: { applicationId: string }) {
  const kit = useResource(() => api.kit(applicationId));
  const saved = useResource(() => api.savedAnswers());
  // The latest kit a write gave back. A read at its revision or later wins over it: a read at
  // revision N comes after write N committed, so it also holds what has changed since without a
  // write, such as a letter finished for the job.
  const [written, setWritten] = useState<KitView | null>(null);
  const view = written && (!kit.data || written.revision > kit.data.revision) ? written : kit.data;
  // Bumped when the kit is loaded again, so the forms below start over from what is stored.
  const [loaded, setLoaded] = useState(0);
  const action = useAction();
  const id = useId();

  /** Sends one write at the revision on screen, and settles a lost reply from a fresh read. */
  async function write(submitted: KitWrite, send: (revision: number) => Promise<KitView>): Promise<boolean> {
    if (!view) return false;
    const revision = view.revision;
    // Keeping a typed answer adds a saved answer, which the choices below are made from.
    const saving = submitted.kind === "answer" && submitted.change.kind === "save";
    return action.run(async () => {
      let next: KitView;
      try {
        next = await send(revision);
      } catch (error) {
        if (ending(error)) throw error;
        if (saving) await saved.reload();
        let current: KitView;
        try {
          current = await api.kit(applicationId);
        } catch (readError) {
          if (ending(readError)) throw readError;
          throw error;
        }
        if (!kitWriteObserved(current, revision, submitted)) throw error;
        next = current;
      }
      setWritten(next);
      if (saving) await saved.reload();
    });
  }

  /** After a refused or unsettled write: reads the kit and the saved answers again, and the forms start over from them. */
  async function loadAgain() {
    await action.run(async () => {
      const [current] = await Promise.all([kit.reload(), saved.reload()]);
      // A read that failed has said why on its own, or ended the session.
      if (!current) throw new Error("the kit was not read");
      setWritten(null);
      setLoaded((count) => count + 1);
    });
  }

  return (
    <section className="workspace-section app-kit" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Application kit</h3>
      <p className="rs-meta">
        Put together what you’ll send for this job: a resume, a cover letter and interview preparation if you want them, and
        your answers to the employer’s questions. Nothing is sent from here. Once you approve the kit, download it and send it
        yourself.
      </p>
      {view ? (
        <>
          <KitParts key={`parts-${loaded}`} view={view} action={action} write={write} />
          <KitQuestions key={`questions-${loaded}`} view={view} action={action} write={write} saved={saved.data?.savedAnswers ?? []} />
          <KitStatus view={view} action={action} write={write} applicationId={applicationId} />
          <ActionError message={action.error} />
          {action.error && (
            <div className="actions">
              <button type="button" className="small" disabled={action.pending} onClick={() => void loadAgain()}>
                Load the kit again
              </button>
            </div>
          )}
        </>
      ) : kit.error ? (
        <ErrorNote message={kit.error} onRetry={kit.reload} />
      ) : (
        <Loading>Loading the application kit…</Loading>
      )}
    </section>
  );
}

type Write = (submitted: KitWrite, send: (revision: number) => Promise<KitView>) => Promise<boolean>;
type PartProps = { view: KitView; action: Action; write: Write };

function KitParts({ view, action, write }: PartProps) {
  const chosen = () => ({ resume: partKey(view.resume), letter: partKey(view.letter), prep: partKey(view.prep) });
  const [draft, setDraft] = useState(chosen);
  // A kit read or written anew shows its own choices, unless some are being changed.
  const [base, setBase] = useState(view.revision);
  const dirty = JSON.stringify(draft) !== JSON.stringify(chosen());
  useEffect(() => {
    if (view.revision !== base && !dirty) {
      setDraft(chosen());
      setBase(view.revision);
    }
  }, [view.revision]);
  const id = useId();
  const version = (choice: KitChoice) => `Version ${choice.version}, made ${formatDate(choice.createdAt)}`;
  /** The options for one part: what can be chosen now, and what is chosen even if it no longer can be. */
  const options = (choices: KitChoice[], current: KitPart | null) => {
    const listed = choices.map((choice) => ({ key: partKey(choice), label: version(choice) }));
    if (current && !listed.some((option) => option.key === partKey(current))) listed.push({ key: partKey(current), label: `Version ${current.version}` });
    return listed;
  };
  const resumes = options(view.choices.resumes, view.resume);
  async function save() {
    const parts = { resume: fromKey(draft.resume), letter: fromKey(draft.letter), prep: fromKey(draft.prep) };
    await write({ kind: "parts", ...parts }, (revision) => api.chooseKitParts(view.applicationId, parts, revision));
  }
  return (
    <form
      className="app-kit__parts"
      aria-label="What goes in the kit"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {resumes.length === 0 ? (
        <p className="rs-meta">Make a resume for this job first. Only a version whose every line is backed by your facts can go in a kit.</p>
      ) : (
        <Field id={`${id}-resume`} label="Resume">
          <select id={`${id}-resume`} value={draft.resume} disabled={action.pending} onChange={(event) => setDraft({ ...draft, resume: event.target.value })}>
            {!draft.resume && <option value="">Choose a version</option>}
            {resumes.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="field-grid">
        <Field id={`${id}-letter`} label="Cover letter (optional)">
          <select id={`${id}-letter`} value={draft.letter} disabled={action.pending} onChange={(event) => setDraft({ ...draft, letter: event.target.value })}>
            <option value="">None</option>
            {options(view.choices.letters, view.letter).map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-prep`} label="Interview preparation (optional)">
          <select id={`${id}-prep`} value={draft.prep} disabled={action.pending} onChange={(event) => setDraft({ ...draft, prep: event.target.value })}>
            <option value="">None</option>
            {options(view.choices.preps, view.prep).map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="actions">
        <button type="submit" className="small" disabled={action.pending || !dirty}>
          Save choices
        </button>
      </div>
    </form>
  );
}

/** A question as the list being edited holds it: one already in the kit keeps its ID. */
type DraftQuestion = { key: string; id?: string; text: string };

function KitQuestions({ view, action, write, saved }: PartProps & { saved: SavedAnswer[] }) {
  const held = (): DraftQuestion[] => view.questions.map((question) => ({ key: question.id, id: question.id, text: question.text }));
  const [draft, setDraft] = useState(held);
  const [base, setBase] = useState(view.revision);
  const [pasted, setPasted] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** Set once this list is saved: the kit that comes back replaces it, new questions with their IDs. */
  const [justSaved, setJustSaved] = useState(false);
  const dirty = JSON.stringify(draft.map(({ id, text }) => [id, text])) !== JSON.stringify(view.questions.map((question) => [question.id, question.text]));
  // A kit read or written anew shows its own questions, unless some are being changed here.
  useEffect(() => {
    if (view.revision !== base && (!dirty || justSaved)) {
      setDraft(held());
      setBase(view.revision);
      setJustSaved(false);
    }
  }, [view.revision, justSaved]);
  const id = useId();
  const byId = new Map(view.questions.map((question) => [question.id, question]));

  function add() {
    const lines = pasted.split(/\r\n|[\r\n\u2028\u2029]/).map((line) => line.trim()).filter(Boolean);
    setDraft([...draft, ...lines.map((text) => ({ key: crypto.randomUUID(), text }))]);
    setPasted("");
  }
  const move = (index: number, by: -1 | 1) => {
    const next = [...draft];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    setDraft(next);
  };
  async function save() {
    const questions = draft.map(({ id, text }) => (id ? { id, text } : { text }));
    const ok = await write({ kind: "questions", questions }, (revision) => api.saveKitQuestions(view.applicationId, questions, revision));
    if (ok) {
      setEditing(null);
      setJustSaved(true);
    }
  }

  return (
    <div className="app-kit__questions">
      <h4>The employer’s questions</h4>
      {draft.length > 0 && (
        <ol className="app-kit__list">
          {draft.map((item, index) => {
            const kept = item.id ? byId.get(item.id) : undefined;
            const unchanged = kept && kept.text === item.text ? kept : undefined;
            return (
              <li key={item.key} className="app-kit__question">
                {editing === item.key ? (
                  <Field id={`${id}-edit-${index}`} label={`Question ${index + 1}`}>
                    <textarea id={`${id}-edit-${index}`} rows={2} value={editText} onChange={(event) => setEditText(event.target.value)} />
                  </Field>
                ) : (
                  <Quote text={item.text} size="sm" caption={`Question ${index + 1}`} />
                )}
                <div className="actions">
                  {editing === item.key ? (
                    <button
                      type="button"
                      className="small"
                      disabled={!editText.trim()}
                      onClick={() => {
                        setDraft(draft.map((question) => (question.key === item.key ? { ...question, text: editText.trim() } : question)));
                        setEditing(null);
                      }}
                      aria-label={`Done editing question ${index + 1}`}
                    >
                      Done
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="small"
                      disabled={action.pending}
                      onClick={() => {
                        setEditing(item.key);
                        setEditText(item.text);
                      }}
                      aria-label={`Edit question ${index + 1}`}
                    >
                      Edit
                    </button>
                  )}
                  <button type="button" className="small" disabled={action.pending} onClick={() => setDraft(draft.filter((question) => question.key !== item.key))} aria-label={`Remove question ${index + 1}`}>
                    Remove
                  </button>
                  <button type="button" className="small" disabled={action.pending || index === 0} onClick={() => move(index, -1)} aria-label={`Move up question ${index + 1}`}>
                    Move up
                  </button>
                  <button type="button" className="small" disabled={action.pending || index === draft.length - 1} onClick={() => move(index, 1)} aria-label={`Move down question ${index + 1}`}>
                    Move down
                  </button>
                </div>
                {unchanged && !dirty ? (
                  <QuestionAnswer key={`${unchanged.id}:${unchanged.state}`} question={unchanged} view={view} action={action} write={write} saved={saved} />
                ) : (
                  <p className="rs-hint">Save the questions to answer this one.</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <Field id={`${id}-paste`} label="Paste the employer’s questions, one per line">
        <textarea id={`${id}-paste`} rows={3} value={pasted} disabled={action.pending} onChange={(event) => setPasted(event.target.value)} />
      </Field>
      <div className="actions">
        <button type="button" className="small" disabled={action.pending || !pasted.trim()} onClick={add}>
          Add questions
        </button>
        <button type="button" className="small primary" disabled={action.pending || !dirty || draft.length > MAX_KIT_QUESTIONS} onClick={() => void save()}>
          Save questions
        </button>
      </div>
    </div>
  );
}

function QuestionAnswer({ question, view, action, write, saved }: PartProps & { question: KitQuestionView; saved: SavedAnswer[] }) {
  const [answer, setAnswer] = useState(question.typedAnswer ?? "");
  // What is typed here is kept across other writes to the kit, and replaced only when this
  // question's stored answer changes.
  const [stored, setStored] = useState(question.typedAnswer);
  if (stored !== question.typedAnswer) {
    setStored(question.typedAnswer);
    setAnswer(question.typedAnswer ?? "");
  }
  const [use, setUse] = useState("");
  const [keep, setKeep] = useState(false);
  const [label, setLabel] = useState("");
  const id = useId();
  const send = (change: KitAnswerChange) =>
    write({ kind: "answer", questionId: question.id, change }, (revision) => api.answerKitQuestion(view.applicationId, question.id, change, revision));

  if (question.state === "matched") {
    const match = question.savedAnswer;
    return (
      <div className="app-kit__answer">
        <Badge tone="confirmed">Saved answer</Badge>
        {match && (
          <>
            <p>Matched to your saved answer “{match.label}”.</p>
            <p className="app-kit__words">{match.answer}</p>
          </>
        )}
        {question.matchedBy === "judge" && <p className="rs-hint">Suggested from your answers’ labels. Check that it fits.</p>}
        {question.confirmed ? (
          <p className="rs-success">
            <Glyph name="check" />
            You’ve checked this answer.
          </p>
        ) : null}
        <div className="actions">
          {!question.confirmed && (
            <button type="button" className="small primary" disabled={action.pending} onClick={() => void send({ kind: "confirm" })}>
              Use this answer
            </button>
          )}
          <button type="button" className="small" disabled={action.pending} onClick={() => void send({ kind: "reject" })}>
            Not this one
          </button>
        </div>
      </div>
    );
  }

  const sensitive = question.state === "sensitive";
  const offered = saved.filter((answer) => answer.refusedKind === null);
  async function submit() {
    if (!sensitive && use) await send({ kind: "use", savedAnswerId: use });
    else if (!sensitive && keep) await send({ kind: "save", label, answer });
    else await send({ kind: "type", answer });
  }
  return (
    <form
      className="app-kit__answer"
      aria-label={`Answer question ${question.position + 1}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {sensitive ? (
        <>
          <Badge tone="sensitive">Asked every time</Badge>
          <p>
            This question asks about {SENSITIVE_KIND_WORDS[question.sensitiveKind ?? "judge"]}. Answers to questions like this are never
            saved or matched. Type your answer for this application only.
          </p>
        </>
      ) : (
        <>
          <Badge tone="proposed">Needs your answer</Badge>
          <p>None of your saved answers fits this question. Type your answer, or choose a saved answer.</p>
        </>
      )}
      <Field id={`${id}-answer`} label="Your answer">
        <textarea
          id={`${id}-answer`}
          rows={3}
          value={answer}
          maxLength={MAX_KIT_ANSWER_CHARS}
          disabled={action.pending || (!sensitive && !!use)}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </Field>
      {!sensitive && (
        <>
          {offered.length > 0 && (
            <Field id={`${id}-use`} label="Use a saved answer">
              <select id={`${id}-use`} value={use} disabled={action.pending} onChange={(event) => setUse(event.target.value)}>
                <option value="">None</option>
                {offered.map((answer) => (
                  <option key={answer.id} value={answer.id}>
                    {answer.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <label className="app-kit__keep">
            <input type="checkbox" checked={keep} disabled={action.pending || !!use} onChange={(event) => setKeep(event.target.checked)} />
            <span>Also keep this as a saved answer</span>
          </label>
          {keep && !use && (
            <Field id={`${id}-label`} label="Label">
              <input id={`${id}-label`} type="text" value={label} maxLength={MAX_SAVED_LABEL_CHARS} disabled={action.pending} onChange={(event) => setLabel(event.target.value)} />
            </Field>
          )}
        </>
      )}
      <div className="actions">
        <button type="submit" className="small primary" disabled={action.pending || (use ? false : !answer.trim() || (keep && !label.trim()))}>
          Save answer
        </button>
      </div>
    </form>
  );
}

function KitStatus({ view, action, write, applicationId }: PartProps & { applicationId: string }) {
  const sentences = [...new Set(view.problems.map((problem) => KIT_PROBLEMS[problem.code].sentence))].map(typeset);
  const problems =
    sentences.length > 0 ? (
      <ul className="app-kit__problems">
        {sentences.map((sentence) => (
          <li key={sentence}>{sentence}</li>
        ))}
      </ul>
    ) : null;
  if (view.ready && view.approvedAt !== null)
    return (
      <div className="app-kit__status" role="status">
        <p>Approved {formatDate(view.approvedAt)}. Download it and send it yourself.</p>
        <a className="rs-btn" href={api.kitArchiveUrl(applicationId)} download>
          <Glyph name="download" />
          Download kit (ZIP)
        </a>
      </div>
    );
  if (view.state === "approved")
    return (
      <div className="app-kit__status" role="status">
        <p>This kit needs attention before it can be downloaded.</p>
        {problems}
      </div>
    );
  return (
    <div className="app-kit__status">
      <p>Draft. Approve the kit when every question has an answer you’ve typed or checked.</p>
      {problems}
      <div className="actions">
        <button
          type="button"
          className="small primary"
          disabled={action.pending || view.problems.length > 0}
          onClick={() => void write({ kind: "approve" }, (revision) => api.approveKit(view.applicationId, revision))}
        >
          Approve kit
        </button>
      </div>
    </div>
  );
}
