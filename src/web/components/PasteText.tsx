import { useId, useState } from "react";
import {
  MAX_PASTE_CHARS,
  MAX_PASTE_TITLE_CHARS,
  hasLoneSurrogate,
  normalizePastedText,
  type PasteSourceRequest,
} from "../../shared/paste";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";
import { isTransientReadError } from "../polling";
import { ActionError, CharCount, Field, Loading } from "./ui";

/** What is in the two fields, kept by the page (see `AddSourceState`). */
export interface PasteDraft {
  text: string;
  title: string;
}

const ADDED = "Added your text. Resumatic is reading it now, and its roles and facts will appear for you to review.";

/**
 * Text pasted as a source: a brag document, a review, a write-up. It is counted as it will be
 * stored, and goes the way an upload goes, with one key for each press of Add text.
 */
export function PasteText({
  onAdded,
  size = "rail",
  draft,
  onDraft,
  notice,
  onNotice,
}: {
  onAdded: Reload;
  size?: "rail" | "first-run";
  draft: PasteDraft;
  onDraft: (draft: Partial<PasteDraft>) => void;
  notice: string | null;
  onNotice: (sentence: string | null) => void;
}) {
  const id = useId();
  const { run, pending, error, setError } = useAction();
  const { text, title } = draft;
  const [retry, setRetry] = useState<{ body: PasteSourceRequest; key: string } | null>(null);
  const length = normalizePastedText(text).length;
  const tooLong = length > MAX_PASTE_CHARS;

  async function add(body: PasteSourceRequest, key: string) {
    setRetry(null);
    onNotice(null);
    // Retry adding text resends with the same key, for when it isn't clear whether the text
    // arrived. A refusal, such as a second copy or an expired paste, would only be refused again.
    let retryable = true;
    const ok = await run(
      async () => {
        try {
          await api.pasteSource(body, key);
        } catch (e) {
          retryable = isTransientReadError(e);
          throw e;
        }
        await onAdded();
      },
      { too_large: "This text is too long. Pasted text can be up to 60,000 characters." },
    );
    if (ok) {
      onDraft({ text: "", title: "" });
      onNotice(ADDED);
    } else if (retryable) setRetry({ body, key });
  }

  function submit() {
    // Enter in the title submits too; the held button alone doesn't stop that.
    if (pending || tooLong) return;
    setRetry(null);
    onNotice(null);
    if (!normalizePastedText(text)) {
      setError("Paste some text first.");
      return;
    }
    if (hasLoneSurrogate(text) || hasLoneSurrogate(title)) {
      setError("This text couldn’t be read. Paste it as plain text, then try again.");
      return;
    }
    void add({ text, title: title || null }, crypto.randomUUID());
  }

  // Retry adding text resends what failed. Once either field changes, that is no longer what is on
  // screen, so the offer goes and the next Add text sends the change under a new key.
  function edit(change: Partial<PasteDraft>) {
    onDraft(change);
    setRetry(null);
    onNotice(null);
  }

  return (
    <form
      className="app-paste"
      aria-label="Paste text"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field id={`${id}-title`} label="Title" optional hint="Shown in your files, such as “2025 performance review”.">
        <input
          id={`${id}-title`}
          type="text"
          autoComplete="off"
          maxLength={MAX_PASTE_TITLE_CHARS}
          value={title}
          readOnly={pending}
          onChange={(e) => edit({ title: e.target.value })}
          aria-describedby={`${id}-title-hint`}
        />
      </Field>
      <Field
        id={`${id}-text`}
        label="Text to read"
        hint="Paste a brag document, a performance review, a project write-up or a resume. Resumatic reads it as it reads a file, and only you see it."
      >
        <textarea
          id={`${id}-text`}
          rows={size === "first-run" ? 12 : 8}
          value={text}
          readOnly={pending}
          onChange={(e) => edit({ text: e.target.value })}
          aria-describedby={`${id}-text-hint ${id}-count`}
          aria-invalid={tooLong}
        />
      </Field>
      <CharCount id={`${id}-count`} length={length} max={MAX_PASTE_CHARS} />
      <div className="actions">
        <button type="submit" className={size === "first-run" ? "primary large" : "primary small"} disabled={pending || tooLong}>
          {pending ? "Adding…" : "Add text"}
        </button>
      </div>
      {pending && <Loading>Adding your text…</Loading>}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      <ActionError message={error} />
      {retry && (
        <button type="button" className="small" disabled={pending} onClick={() => void add(retry.body, retry.key)}>
          Retry adding text
        </button>
      )}
    </form>
  );
}
