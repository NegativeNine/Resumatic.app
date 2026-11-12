import { Fragment, useId, type RefObject } from "react";
import type { ResumeLine } from "../../../shared/api";
import { presentResumeBullet } from "../../../shared/resume-presentation";
import { LINE_STATUS_LABEL } from "../../format";
import { Badge, LINE_MARK, type MarkTone } from "../ui";

// The marks beside a resume's page: one button per line, level with it, in the page's order. A
// line the check changed, one that uses a fact kept private, one that waits for a fresh check and
// one with a coach's wording waiting on it carry their marks, visibly. A backed line carries none:
// its button is there for the keyboard, out of sight until it is focused. Each opens the one card
// that says where its line came from.

/** One line as the margin lists it: the line, and the role it sits under (null for the summary). */
export interface MarginLine {
  line: ResumeLine;
  roleId: string | null;
}

/** What sets a line apart from a backed one. */
export interface LineExceptions {
  /** An older version's line that hasn't been checked again. */
  pending: boolean;
  /** It uses a fact kept private. */
  sensitive: boolean;
  /** A coach's suggested wording waits on it. */
  suggested: boolean;
}

/** The marks a line carries, in order. None for a line backed by the record as written. */
export function lineMarks(line: ResumeLine, { pending, sensitive, suggested }: LineExceptions): { tone: MarkTone; label: string }[] {
  return [
    ...(pending ? [{ tone: "needs-you" as const, label: "Needs review" }] : line.status !== "kept" ? [{ tone: LINE_MARK[line.status], label: LINE_STATUS_LABEL[line.status] }] : []),
    ...(sensitive ? [{ tone: "note" as const, label: "Private fact" }] : []),
    ...(suggested ? [{ tone: "needs-you" as const, label: "Suggested wording" }] : []),
  ];
}

/** A line's words as the page prints them: a line under a role without the marker it came with. */
export const lineText = ({ line, roleId }: MarginLine) => (roleId === null ? line.text : presentResumeBullet(line.text));

export function LineMarks({
  lines,
  exceptions,
  chosen,
  cardId,
  onChoose,
  buttons,
}: {
  lines: readonly MarginLine[];
  exceptions: (line: ResumeLine) => LineExceptions;
  chosen: string | null;
  /** The card's ID, which every mark controls. */
  cardId: string;
  /** Opens a line's card, or closes it when it is the one open. */
  onChoose: (lineId: string) => void;
  /** Each line's button, by line ID, so focus can return to it when its card closes. */
  buttons: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const id = useId();
  return (
    <ul className="app-line-marks">
      {lines.map((item, index) => {
        const { line } = item;
        const marks = lineMarks(line, exceptions(line));
        const textId = `${id}-${index}`;
        return (
          <li key={line.id} data-note-for={line.id} className={chosen === line.id ? "is-chosen" : undefined}>
            <button
              type="button"
              className={marks.length > 0 ? "app-mark" : "app-mark app-mark--quiet"}
              aria-expanded={chosen === line.id}
              aria-controls={cardId}
              aria-describedby={textId}
              ref={(element) => {
                if (element) buttons.current.set(line.id, element);
                else buttons.current.delete(line.id);
              }}
              onClick={() => onChoose(line.id)}
            >
              {marks.length > 0 ? (
                <>
                  {marks.map((mark, at) => (
                    <Fragment key={mark.label}>
                      {at > 0 && " "}
                      <Badge tone={mark.tone}>{mark.label}</Badge>
                    </Fragment>
                  ))}
                  {/* Where the marks follow the page as a list, each shows its line. Its words are the description. */}
                  <span className="app-mark__line" aria-hidden="true">
                    {lineText(item)}
                  </span>
                </>
              ) : (
                "Where this line came from"
              )}
            </button>
            <span id={textId} hidden>
              {lineText(item)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
