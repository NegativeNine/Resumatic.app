import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { describeError } from "../../errors";
import { sessionEndNote, useSession } from "../../session";

// The text Resumatic read from a file, for the panel beside To check's question. A file's text
// doesn't change once read, so each is loaded once while the page is open and kept in memory only.
// A load that fails is forgotten, so Try again asks again.

type SourceText = Awaited<ReturnType<typeof api.sourceText>>;

export interface SourceTextState {
  markdown?: string;
  pending: boolean;
  error: string | null;
  retry: () => Promise<void>;
}

export function useSourceText(sourceId: string | null): SourceTextState {
  const { endSession } = useSession();
  const loads = useRef(new Map<string, Promise<SourceText>>());
  const [shown, setShown] = useState<{ id: string; markdown?: string; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sourceId) return;
    let current = true;
    let load = loads.current.get(sourceId);
    if (!load) {
      load = api.sourceText(sourceId);
      loads.current.set(sourceId, load);
    }
    const asked = load;
    asked.then(
      (text) => {
        if (current) setShown({ id: sourceId, markdown: text.markdown, error: null });
      },
      (error: unknown) => {
        if (loads.current.get(sourceId) === asked) loads.current.delete(sourceId);
        if (!current) return;
        const note = sessionEndNote(error);
        if (note) endSession(note);
        else setShown({ id: sourceId, error: describeError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [sourceId, attempt, endSession]);

  const retry = useCallback(async () => {
    setShown(null);
    setAttempt((n) => n + 1);
  }, []);

  const mine = shown && shown.id === sourceId ? shown : null;
  return {
    markdown: mine?.markdown,
    pending: sourceId !== null && !mine,
    error: mine?.error ?? null,
    retry,
  };
}
