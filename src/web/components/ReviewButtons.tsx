import { useState, type RefObject } from "react";
import type { ReviewState } from "../../shared/api";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";

export const REVIEW_HEADING_ID = "review-heading";

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
      el?.parentElement?.closest(".group"),
      document.getElementById(REVIEW_HEADING_ID),
    ];
    setDeciding(decision);
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
  /** Added to each label, as in "Confirm role". */
  noun?: string;
  /** ID of the text the buttons act on, so screen readers announce it with each button. */
  describedBy: string;
  review: ReviewControl;
  onEdit?: () => void;
  confirmDisabled?: boolean;
  disabled?: boolean;
}

export function ReviewButtons({
  state,
  noun,
  describedBy,
  review,
  onEdit,
  confirmDisabled = false,
  disabled = false,
}: Props) {
  const busy = review.deciding !== null || disabled;
  const suffix = noun ? ` ${noun}` : "";

  return (
    <div className="actions">
      {state !== "confirmed" && (
        <button
          type="button"
          className="primary small"
          aria-describedby={describedBy}
          disabled={busy || confirmDisabled}
          onClick={() => void review.decide("confirm")}
        >
          {review.deciding === "confirm" ? "Confirming…" : `Confirm${suffix}`}
        </button>
      )}
      {state !== "rejected" && (
        <button
          type="button"
          className="small"
          aria-describedby={describedBy}
          disabled={busy}
          onClick={() => void review.decide("reject")}
        >
          {review.deciding === "reject" ? "Rejecting…" : `Reject${suffix}`}
        </button>
      )}
      {onEdit && (
        <button
          type="button"
          className="small quiet"
          aria-describedby={describedBy}
          disabled={busy}
          onClick={onEdit}
        >
          Edit{suffix}
        </button>
      )}
    </div>
  );
}
