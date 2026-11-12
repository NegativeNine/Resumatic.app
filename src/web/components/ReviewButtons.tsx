import { useState, type ReactNode, type RefObject } from "react";
import type { ReviewState } from "../../shared/api";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";

export const REVIEW_HEADING_ID = "review-heading";

/** How long a decided item's tick stays filled before the item leaves the list. */
export const TICK_HOLD_MS = 160;

function holdTick(): Promise<void> {
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? Promise.resolve() : new Promise((resolve) => window.setTimeout(resolve, TICK_HOLD_MS));
}

type Decision = "confirm" | "reject";

export interface ReviewControl {
  decide: (decision: Decision) => Promise<void>;
  deciding: Decision | null;
  error: string | null;
}

/**
 * Confirms or rejects one role or fact. The item usually leaves the filtered list afterwards, so
 * focus goes to the item if it is still shown, otherwise to a neighbour or the review heading.
 */
export function useReview(
  id: string,
  reload: Reload,
  item: RefObject<HTMLElement | null>,
  revision = 1,
  duplicates: { id: string; revision?: number }[] = [],
): ReviewControl {
  const { run, error } = useAction();
  const [deciding, setDeciding] = useState<Decision | null>(null);

  async function decide(decision: Decision) {
    const el = item.current;
    const candidates = [
      el,
      el?.nextElementSibling,
      el?.previousElementSibling,
      el?.parentElement?.closest("[data-review-group]"),
      document.getElementById(REVIEW_HEADING_ID),
    ];
    setDeciding(decision);
    const hold = holdTick();
    const ok = await run(async () => {
      const items = [{ id, revision }, ...duplicates];
      const ids = items.map((item) => item.id);
      try {
        await api.review({
          confirm: decision === "confirm" ? ids : [],
          reject: decision === "reject" ? ids : [],
          expectedRevisions: Object.fromEntries(items.map((item) => [item.id, item.revision ?? 1])),
        });
      } catch (error) {
        // A lost response can follow an already committed transaction. Fetch
        // the actual states before a retry; retain the original error if the
        // refresh also fails.
        try { await reload(); } catch { /* keep the decision error */ }
        throw error;
      }
      // The filled tick shows the decision landed before the item leaves the list.
      await hold;
      await reload();
    });
    setDeciding(null);
    if (ok) {
      candidates
        .find(
          (c): c is HTMLElement =>
            c instanceof HTMLElement &&
            c.isConnected &&
            c.hasAttribute("tabindex"),
        )
        ?.focus();
    }
  }

  return { decide, deciding, error };
}

interface Props {
  state: ReviewState;
  /**
   * ID of the text the buttons act on, so screen readers announce it with each button. A role's
   * buttons read the same as a fact's; this is what names the item.
   */
  describedBy: string;
  review: ReviewControl;
  onEdit?: () => void;
  /** Replaces the plain rejection, for a role that asks first. */
  onReject?: () => void;
  /** Whether onReject has opened its question. */
  rejectExpanded?: boolean;
  confirmDisabled?: boolean;
  disabled?: boolean;
  /** Show the keyboard hints, on the active item of the review queue. */
  showKeys?: boolean;
  /** Full-size buttons, for the one question To check asks at a time. */
  large?: boolean;
  /** One more control for this item, after Leave it out. It has no key of its own. */
  extra?: ReactNode;
}

export function ReviewButtons({
  state,
  describedBy,
  review,
  onEdit,
  onReject,
  rejectExpanded,
  confirmDisabled = false,
  disabled = false,
  showKeys = false,
  large = false,
  extra,
}: Props) {
  const busy = review.deciding !== null || disabled;
  const size = large ? "" : " rs-btn--sm";

  return (
    <div className="rs-actions">
      {state !== "confirmed" && (
        <button
          type="button"
          className={`rs-btn rs-btn--primary${size}`}
          aria-describedby={describedBy}
          aria-keyshortcuts="Y"
          data-review-action="confirm"
          disabled={busy || confirmDisabled}
          onClick={() => void review.decide("confirm")}
        >
          {review.deciding === "confirm" ? "Saving…" : "That’s right"}
        </button>
      )}
      {onEdit && (
        <button
          type="button"
          className={`rs-btn${size}`}
          aria-describedby={describedBy}
          aria-keyshortcuts="F"
          data-review-action="edit"
          disabled={busy}
          onClick={onEdit}
        >
          Fix it
        </button>
      )}
      {state !== "rejected" && (
        <button
          type="button"
          className={`rs-btn${size}`}
          aria-describedby={describedBy}
          aria-keyshortcuts="L"
          aria-expanded={onReject ? Boolean(rejectExpanded) : undefined}
          data-review-action="reject"
          disabled={busy}
          onClick={() => (onReject ? onReject() : void review.decide("reject"))}
        >
          {review.deciding === "reject" ? "Saving…" : "Leave it out"}
        </button>
      )}
      {extra}
      {showKeys && (
        <span className="rs-actions__keys" aria-hidden="true">
          {state !== "confirmed" && (
            <span>
              <kbd className="rs-kbd">Y</kbd> that’s right
            </span>
          )}
          {onEdit && (
            <span>
              <kbd className="rs-kbd">F</kbd> fix it
            </span>
          )}
          {state !== "rejected" && (
            <span>
              <kbd className="rs-kbd">L</kbd> leave it out
            </span>
          )}
          <span>
            <kbd className="rs-kbd">J</kbd>
            <kbd className="rs-kbd">K</kbd> next and previous
          </span>
        </span>
      )}
    </div>
  );
}
