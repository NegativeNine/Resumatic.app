import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

// The one card that says where a chosen line came from. Beside the page it sits level with its line,
// placed by the margin's layout after its line's mark; below 860px it is a sheet from the bottom of
// the screen that leaves the line in view, so it isn't modal. It never marks a coach's comment seen:
// the comments on Sharing do that.

/**
 * A line's card. Its heading takes focus when it opens, and when it comes back for a newer version
 * while focus was inside the one before: `focusRequest` carries that across, set by an opening and
 * by a card that is taken away with focus inside it. Escape and Close close it, except while its
 * line is being edited, so nothing typed is lost.
 */
export function LineCard({
  cardId,
  lineId,
  text,
  presentation,
  editing,
  focusRequest,
  headingRef,
  onClose,
  children,
}: {
  cardId: string;
  lineId: string;
  /** The line's words as the page prints them. */
  text: string;
  presentation: "margin" | "sheet";
  editing: boolean;
  focusRequest: RefObject<boolean>;
  /** The card's heading, so the editor can hand focus back to it when it closes. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const inside = useRef(false);
  const headingId = `${cardId}-heading`;

  useLayoutEffect(() => {
    const element = card.current;
    if (focusRequest.current) {
      focusRequest.current = false;
      headingRef.current?.focus({ preventScroll: presentation === "margin" });
    }
    return () => {
      // A card taken away with focus inside it, for a newer version, hands focus to the next one.
      focusRequest.current = focusRequest.current || inside.current || (!!element && element.contains(document.activeElement));
    };
    // Once per card: a card shown again is a new one.
  }, []);

  const role = presentation === "sheet" ? { role: "dialog", "aria-modal": false } : { role: "region" };
  return (
    <div
      ref={card}
      id={cardId}
      className="rs-panel app-line-card"
      data-card-for={lineId}
      data-presentation={presentation}
      aria-labelledby={headingId}
      {...role}
      onFocus={() => {
        inside.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) inside.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || editing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <h3 id={headingId} className="rs-h3" tabIndex={-1} ref={headingRef}>
        Where this line came from
      </h3>
      <p className="app-line-card__line">{text}</p>
      {children}
      {editing && <p className="rs-hint">Finish or cancel your edit to see another line.</p>}
      <div className="app-line-card__close">
        <button type="button" className="small" disabled={editing} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
