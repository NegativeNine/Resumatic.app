import { useEffect, useRef, useState, type RefObject } from "react";
import type { FactView } from "../../shared/api";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";

// Keeping a fact private, and stopping. Keeping it private acts at once, because it only ever
// takes a fact out of use. Stopping always asks first, because it can put a fact back into a shared
// copy that is still out there. Stored and API names stay "sensitive"; the interface says private.

/** What a private fact says under its words. */
export const PRIVATE_HINT =
  "Kept private. Never used in a new resume, letter, interview preparation or fit preview, never put in a shared copy and never shown to a connected app. Facts with the same words are kept private with it.";

export interface SensitiveControl {
  /** Marks the fact, and the copies shown with it, at once. */
  mark: () => void;
  /** Opens the question about unmarking, or closes it. */
  ask: () => void;
  /** Unmarks, from the question. */
  unmark: () => void;
  /** Closes the question and returns focus to the button that opened it. */
  cancel: () => void;
  /** Closes the question without moving focus, as when the fact's editor opens over it. */
  close: () => void;
  asking: boolean;
  pending: "mark" | "unmark" | null;
  error: string | null;
  button: RefObject<HTMLButtonElement | null>;
}

/**
 * Marks or unmarks one fact as shown: the fact and the copies grouped with it go in one request,
 * each with the revision the page showed. The server marks every other fact with the same words.
 */
export function useSensitive(fact: FactView, duplicates: FactView[], reload: Reload): SensitiveControl {
  const { run, error } = useAction();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState<"mark" | "unmark" | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const settled = useRef(false);

  // Once a request has settled and the button is usable again. The question has closed by then, or
  // the button was disabled while the request ran, and either can leave focus nowhere: then it goes
  // back to the button. Focus the person moved elsewhere is left where they put it.
  useEffect(() => {
    if (pending !== null || !settled.current) return;
    settled.current = false;
    if (!document.activeElement || document.activeElement === document.body) button.current?.focus();
  }, [pending]);

  async function set(sensitive: boolean) {
    setAsking(false);
    setPending(sensitive ? "mark" : "unmark");
    await run(async () => {
      const items = [fact, ...duplicates];
      try {
        await api.markSensitive({
          ids: items.map((item) => item.id),
          sensitive,
          expectedRevisions: Object.fromEntries(items.map((item) => [item.id, item.revision ?? 1])),
        });
      } catch (error) {
        // A lost response can follow a change that was made. Show the facts as they are before
        // anyone tries again, and keep the original error if that refresh fails too.
        try { await reload(); } catch { /* keep the error from the request */ }
        throw error;
      }
      await reload();
    });
    settled.current = true;
    setPending(null);
  }

  return {
    mark: () => void set(true),
    ask: () => setAsking((open) => !open),
    unmark: () => void set(false),
    cancel: () => {
      setAsking(false);
      button.current?.focus();
    },
    close: () => setAsking(false),
    asking,
    pending,
    error,
    button,
  };
}

/** The one button: "Keep private" on a fact that isn't, "Stop keeping it private" on one that is. */
export function SensitiveButton({
  control,
  marked,
  describedBy,
  disabled = false,
}: {
  control: SensitiveControl;
  marked: boolean;
  /** ID of the fact's text, so screen readers announce it with the button. */
  describedBy: string;
  disabled?: boolean;
}) {
  const label =
    control.pending === "mark" ? "Keeping it private…" : control.pending === "unmark" ? "Saving…" : marked ? "Stop keeping it private" : "Keep private";
  return (
    <button
      ref={control.button}
      type="button"
      className="rs-btn rs-btn--sm"
      aria-describedby={describedBy}
      aria-expanded={marked ? control.asking : undefined}
      disabled={disabled || control.pending !== null}
      onClick={marked ? control.ask : control.mark}
    >
      {label}
    </button>
  );
}

/**
 * The question asked before a fact stops being private. It says what that puts back in use. Its answer
 * waits, as the button does, while the list is held for an open editor or a review is on its way.
 */
export function SensitiveWell({ control, disabled = false }: { control: SensitiveControl; disabled?: boolean }) {
  if (!control.asking) return null;
  return (
    <div className="rs-well" role="group" aria-label="Stop keeping this fact private">
      <p className="rs-p app-well-text">
        It can be used again in resumes and documents, and connected apps can read it. Resumes that use it can be
        downloaded and shared again, and any shared copy that holds it opens again for anyone with its link. Facts
        with the same words stop being private with it.
      </p>
      <div className="rs-actions app-well-actions">
        <button type="button" className="rs-btn rs-btn--primary rs-btn--sm" autoFocus disabled={disabled} onClick={control.unmark}>
          Yes, stop keeping it private
        </button>
        <button type="button" className="rs-btn rs-btn--sm" onClick={control.cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
