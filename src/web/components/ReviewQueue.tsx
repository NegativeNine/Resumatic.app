import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/** What a queue item can do from the keyboard. Leave an action out when its button isn't shown. */
export interface QueueActions {
  confirm?: () => void;
  edit?: () => void;
  reject?: () => void;
}

interface Queue {
  activeId: string | null;
  register: (id: string, actions: () => QueueActions) => () => void;
}

const QueueContext = createContext<Queue | null>(null);

const KEYS = new Set(["c", "e", "r", "j", "k"]);

/** Text fields, selects and editable regions keep their keys: typing never triggers a shortcut. */
function isTyping(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["radio", "checkbox", "button", "submit", "reset"].includes(target.type);
}

/**
 * The review queue: roles and facts in page order, one of them active. While focus is inside the
 * queue, C confirms, E edits and R rejects the active item, and J and K move to the next and
 * previous item. The keys work only with focus inside, which keeps them clear of speech input
 * and typing elsewhere on the page (WCAG 2.1.4); the buttons stay the main way to review.
 */
export function ReviewQueue({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, () => QueueActions>());
  const [activeId, setActiveId] = useState<string | null>(null);

  const register = useCallback((id: string, actions: () => QueueActions) => {
    items.current.set(id, actions);
    return () => {
      if (items.current.get(id) === actions) items.current.delete(id);
    };
  }, []);

  const nodes = useCallback(
    () => [...(container.current?.querySelectorAll<HTMLElement>("[data-queue-item]") ?? [])],
    [],
  );

  // Keep an active item: the one used last while it's still shown, otherwise the first one.
  useEffect(() => {
    const shown = nodes();
    if (activeId !== null && shown.some((n) => n.dataset.queueItem === activeId)) return;
    const first = shown[0]?.dataset.queueItem ?? null;
    if (first !== activeId) setActiveId(first);
  });

  function onFocus(e: FocusEvent<HTMLDivElement>) {
    const item = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-queue-item]") : null;
    const id = item?.dataset.queueItem;
    if (id && id !== activeId) setActiveId(id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat || isTyping(e.target)) return;
    const key = e.key.toLowerCase();
    if (!KEYS.has(key)) return;
    // The focused item is the active one, even if its focus hasn't re-rendered the queue yet.
    const focused = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-queue-item]")?.dataset.queueItem : undefined;
    const current = focused ?? activeId;
    if (key === "j" || key === "k") {
      const shown = nodes();
      const index = shown.findIndex((n) => n.dataset.queueItem === current);
      const next = shown[key === "j" ? index + 1 : Math.max(0, index - 1)];
      if (!next) return;
      e.preventDefault();
      next.focus();
      setActiveId(next.dataset.queueItem ?? null);
      return;
    }
    const actions = current ? items.current.get(current)?.() : undefined;
    const run = key === "c" ? actions?.confirm : key === "e" ? actions?.edit : actions?.reject;
    if (!run) return;
    e.preventDefault();
    run();
  }

  const queue = useMemo(() => ({ activeId, register }), [activeId, register]);

  return (
    <QueueContext value={queue}>
      <div className="review-queue" ref={container} onKeyDown={onKeyDown} onFocus={onFocus}>
        {children}
      </div>
    </QueueContext>
  );
}

/**
 * Registers a role or fact with the review queue, and says whether it's the active item. The
 * element must carry data-queue-item={id} and tabIndex={-1}, so J and K can focus it.
 */
export function useQueueItem(id: string, actions: QueueActions): boolean {
  const queue = useContext(QueueContext);
  const latest = useRef(actions);
  latest.current = actions;
  const register = queue?.register;
  useEffect(() => register?.(id, () => latest.current), [register, id]);
  return queue?.activeId === id;
}
