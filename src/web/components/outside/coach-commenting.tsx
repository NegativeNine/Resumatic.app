import { useState } from "react";
import type { SharedView, ShareTarget } from "../../../shared/sharing";
import { CoachComments } from "../ShareComments";
import { sameTarget, type ShareCommenting } from "../ShareSnapshotContent";
import { ErrorNote } from "../ui";

// Commenting on a client's copy, for the coach it names, wherever the copy is read: at /share with
// the link, and in the app from the client list. It holds which line or fact is chosen and, once
// the comments are refused, the one sentence that says why. Both start over with each reading of the
// copy, so a copy added again, or read again, can be commented on again.

export interface CoachCommenting {
  /** What `SharedCopy` takes, or undefined when this reader can't comment on this copy. */
  comments: ShareCommenting | undefined;
  /** Why commenting is over for this reader, as the comments were refused, or null. */
  ended: string | null;
}

/**
 * Comments for `view`, when its reader is the coach who has it in their list and it holds a line or
 * a fact (letters and preparation have neither). `onUnlisted` is called when the comments find the
 * copy isn't in the list after all, as when another tab took it off. A refusal because the copy or
 * the session has ended lets go of what was chosen, puts its sentence in place of the threads, and
 * then calls `onEnded` with it.
 */
export function useCoachCommenting(
  view: SharedView | null,
  { onUnlisted, onEnded }: { onUnlisted: () => void; onEnded?: (sentence: string) => void },
): CoachCommenting {
  /** The line or fact the coach has chosen to comment on. One at a time. */
  const [selected, setSelected] = useState<ShareTarget | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  // Each reading of the copy starts over. Set while rendering, so no frame shows the last reading's choice.
  const [reading, setReading] = useState(view);
  if (reading !== view) {
    setReading(view);
    setSelected(null);
    setEnded(null);
  }

  const commentable = !!view && (view.snapshot.facts.length > 0 || view.snapshot.resumes.length > 0);
  if (!view || view.reviewer !== "joined" || !commentable) return { comments: undefined, ended };
  if (ended !== null)
    // Commenting is over: its one sentence stands in place of the threads, and nothing on the copy can be chosen.
    return { comments: { selected: null, aside: <ErrorNote message={ended} /> }, ended };
  return {
    comments: {
      selected,
      // Choosing the chosen one again lets go of it.
      onSelect: (target) => setSelected((current) => (sameTarget(current, target) ? null : target)),
      aside: (
        <CoachComments
          view={view}
          selected={selected}
          onUnlisted={() => {
            setSelected(null);
            onUnlisted();
          }}
          onEnded={(sentence) => {
            setSelected(null);
            setEnded(sentence);
            onEnded?.(sentence);
          }}
        />
      ),
    },
    ended,
  };
}
