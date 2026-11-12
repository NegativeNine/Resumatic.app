import { useId, useState } from "react";
import {
  MAX_SAVED_ANSWER_CHARS,
  MAX_SAVED_LABEL_CHARS,
  SENSITIVE_KIND_WORDS,
  type SavedAnswer,
} from "../../shared/kit";
import { api } from "../api";
import { useAction, useResource } from "../hooks";
import { sessionEndNote } from "../session";
import { ActionError, EmptyState, ErrorNote, Field, Loading, Message } from "./ui";

// The Saved answers card on Account: short answers the person gives on many applications, in their
// own words. It loads from its own route. An application kit offers one when an employer's
// question fits its label; nothing else reads them, and their words are never sent to a model.

const LABEL_HINT = "A short name, such as “Notice period” or “Portfolio link”.";

export function SavedAnswers() {
  const saved = useResource(() => api.savedAnswers());
  const id = useId();
  return (
    <section className="card app-saved-answers" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Saved answers</h2>
      <p className="card-text meta">
        Short answers you give on many applications, in your own words. An application kit offers one when an employer’s
        question fits its label. Your answers stay in your vault, and their words are never sent to an AI model.
      </p>
      <Message tone="info" live={false}>
        Questions about work authorisation, visas, sponsorship or citizenship, pay, or personal details such as age, health or
        family are never saved. They’re asked every time you apply.
      </Message>
      {saved.data ? (
        <SavedAnswerList answers={saved.data.savedAnswers} reload={saved.reload} />
      ) : saved.error ? (
        <ErrorNote message={saved.error} onRetry={saved.reload} />
      ) : (
        <Loading>Loading your saved answers…</Loading>
      )}
    </section>
  );
}

function SavedAnswerList({ answers, reload }: { answers: SavedAnswer[]; reload: () => Promise<unknown> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const action = useAction();
  return (
    <>
      {answers.length === 0 ? (
        <EmptyState>No saved answers yet.</EmptyState>
      ) : (
        <ul className="app-saved-answers__list">
          {answers.map((answer) =>
            editing === answer.id ? (
              <li key={answer.id}>
                <SavedAnswerForm
                  initial={answer}
                  reload={reload}
                  onCancel={() => setEditing(null)}
                  onSaved={async () => {
                    setEditing(null);
                    setJustSaved(true);
                    await reload();
                  }}
                />
              </li>
            ) : (
              <li key={answer.id} className="app-saved-answer">
                <p className="app-saved-answer__label">
                  <strong>{answer.label}</strong>
                </p>
                <p className="app-saved-answer__text">{answer.answer}</p>
                {answer.refusedKind && (
                  <p className="rs-inline-error">This answer can’t be offered any more: it’s about {SENSITIVE_KIND_WORDS[answer.refusedKind]}.</p>
                )}
                <div className="actions">
                  <button type="button" className="small" disabled={action.pending} onClick={() => setEditing(answer.id)} aria-label={`Edit ${answer.label}`}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={action.pending}
                    onClick={() =>
                      void action.run(async () => {
                        await api.deleteSavedAnswer(answer.id);
                        setJustSaved(false);
                        await reload();
                      })
                    }
                    aria-label={`Delete ${answer.label}`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      <ActionError message={action.error} />
      {editing === null && (
        <SavedAnswerForm
          reload={reload}
          onSaved={async () => {
            setJustSaved(true);
            await reload();
          }}
        />
      )}
      {justSaved && (
        <p className="success inline" role="status">
          Saved.
        </p>
      )}
    </>
  );
}

/**
 * A form for a new saved answer, or for changing one at the revision it was read at. A refused or
 * lost save reads the list again, keeping what was typed: the next save names the revision held
 * now, and an answer kept under the same label is shown.
 */
function SavedAnswerForm({
  initial,
  reload,
  onSaved,
  onCancel,
}: {
  initial?: SavedAnswer;
  reload: () => Promise<unknown>;
  onSaved: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [answer, setAnswer] = useState(initial?.answer ?? "");
  const action = useAction();
  const id = useId();
  async function save() {
    const ok = await action.run(async () => {
      const input = { label, answer };
      try {
        if (initial) await api.editSavedAnswer(initial.id, input, initial.revision);
        else await api.addSavedAnswer(input);
      } catch (error) {
        if (!sessionEndNote(error)) await reload();
        throw error;
      }
    });
    if (ok) {
      if (!initial) {
        setLabel("");
        setAnswer("");
      }
      await onSaved();
    }
  }
  return (
    <form
      className="app-saved-answers__form"
      aria-busy={action.pending}
      aria-label={initial ? `Edit ${initial.label}` : "Add a saved answer"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field id={`${id}-label`} label="Label" hint={LABEL_HINT}>
        <input
          id={`${id}-label`}
          type="text"
          value={label}
          maxLength={MAX_SAVED_LABEL_CHARS}
          readOnly={action.pending}
          aria-describedby={`${id}-label-hint`}
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>
      <Field id={`${id}-answer`} label="Answer">
        <textarea
          id={`${id}-answer`}
          rows={3}
          value={answer}
          maxLength={MAX_SAVED_ANSWER_CHARS}
          readOnly={action.pending}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </Field>
      <div className="actions">
        <button type="submit" className="small primary" disabled={action.pending || !label.trim() || !answer.trim()}>
          {action.pending ? "Saving…" : "Save answer"}
        </button>
        {onCancel && (
          <button type="button" className="small" disabled={action.pending} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <ActionError message={action.error} />
    </form>
  );
}
