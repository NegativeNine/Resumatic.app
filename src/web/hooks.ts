import { useCallback, useEffect, useRef, useState } from "react";
import { VAULT_CHANGED } from "./live";
import { describeError, type ErrorWords } from "./errors";
import { sessionEndNote, useSession } from "./session";

export const POLL_MS = 2000;

export type Reload = () => Promise<unknown>;

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  reload: () => Promise<T | undefined>;
}

/**
 * Loads data on mount, then again every POLL_MS while `pollWhile` holds for the latest result.
 * Only the newest request's answer is kept, and `reload` resolves once that answer is on screen,
 * so callers can move focus or close editors against the updated page. `load` should not depend
 * on changing props: give the component a `key` instead.
 */
export function useResource<T>(
  load: () => Promise<T>,
  pollWhile?: (data: T) => boolean,
): Resource<T> {
  const { endSession } = useSession();
  const [view, setView] = useState<{ data: T | undefined; error: string | null; sequence: number }>({
    data: undefined, error: null, sequence: 0,
  });
  const latest = useRef({ load, pollWhile, endSession });
  const requests = useRef({ seq: 0, timer: 0 });
  const renderWaiters = useRef<{ sequence: number; resolve: (value: T | undefined) => void }[]>([]);

  useEffect(() => {
    latest.current = { load, pollWhile, endSession };
    // A waiter is satisfied only by a commit containing its response (or a
    // later response). Unrelated renders do not unlock pending actions.
    const waiting = renderWaiters.current;
    renderWaiters.current = [];
    for (const waiter of waiting) {
      if (waiter.sequence <= view.sequence)
        waiter.resolve(waiter.sequence === view.sequence ? view.data : undefined);
      else renderWaiters.current.push(waiter);
    }
  });

  const reload = useCallback(async function fetchLatest(): Promise<
    T | undefined
  > {
    const r = requests.current;
    const seq = ++r.seq;
    window.clearTimeout(r.timer);
    try {
      const next = await latest.current.load();
      if (seq !== r.seq) return undefined;
      // Even an identical result must commit once: callers await this before
      // closing an editor or restoring focus. Register before scheduling the
      // update so a fast commit cannot overtake the waiter.
      const committed = new Promise<T | undefined>((resolve) => {
        renderWaiters.current.push({ sequence: seq, resolve });
      });
      setView({ data: next, error: null, sequence: seq });
      if (latest.current.pollWhile?.(next))
        r.timer = window.setTimeout(fetchLatest, POLL_MS);
      return await committed;
    } catch (e) {
      if (seq !== r.seq) return undefined;
      const note = sessionEndNote(e);
      if (note) latest.current.endSession(note);
      else setView((previous) => ({ ...previous, error: describeError(e) }));
      return undefined;
    }
  }, []);

  useEffect(() => {
    const r = requests.current;
    void reload();
    const onChange = () => {
      void reload();
    };
    window.addEventListener(VAULT_CHANGED, onChange);
    return () => {
      window.removeEventListener(VAULT_CHANGED, onChange);
      r.seq++;
      window.clearTimeout(r.timer);
      for (const waiter of renderWaiters.current.splice(0)) waiter.resolve(undefined);
    };
  }, [reload]);

  return { data: view.data, error: view.error, reload };
}

export interface Action {
  /** Runs `task`, returning whether it succeeded. Ignored while another task is running. */
  run: (task: () => Promise<unknown>, words?: ErrorWords) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  setError: (message: string | null) => void;
}

/** Pending and error state for a request the user starts, such as saving a form. */
export function useAction(): Action {
  const { endSession } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (task: () => Promise<unknown>, words?: ErrorWords) => {
      if (busy.current) return false;
      busy.current = true;
      setPending(true);
      setError(null);
      try {
        await task();
        return true;
      } catch (e) {
        const note = sessionEndNote(e);
        if (note) endSession(note);
        else setError(describeError(e, words));
        return false;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [endSession],
  );

  return { run, pending, error, setError };
}
