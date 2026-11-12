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

const KEYS = new Set(["y", "f", "l", "j", "k"]);

/** Text fields, selects and editable regions keep their keys: typing never triggers a shortcut. */
function isTyping(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["radio", "checkbox", "button", "submit", "reset"].includes(target.type);
}

/**
 * A question an item asks before acting ("Leave out …?", "Stop keeping this fact private") answers only to its own
 * buttons. Its Yes button takes focus, and a Y pressed there means yes to the question, never
 * "That's right" to the item.
 */
function inQuestion(target: EventTarget, queue: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const question = target.closest(".rs-well");
  return question !== null && queue !== null && queue.contains(question);
}

/** An editor open inside the container keeps every key: what is typed there is a draft, never an answer. */
function inForm(target: EventTarget, container: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const form = target.closest("form");
  return form !== null && container !== null && container.contains(form);
}

/** A review key: Y that's right, F fix it, L leave it out, J next and K back. */
export type ReviewKey = "y" | "f" | "l" | "j" | "k";

/**
 * The review key a key press is, or null when it must be left alone: already handled, with Alt,
 * Ctrl or Meta held, on key repeat, while typing, or with focus in a question or an editor inside
 * the container. The review queue on All facts and the question on To check both use it.
 */
export function reviewKeyOf(e: KeyboardEvent<HTMLElement>, container: HTMLElement | null): ReviewKey | null {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat || isTyping(e.target)) return null;
  if (inQuestion(e.target, container) || inForm(e.target, container)) return null;
  const key = e.key.toLowerCase();
  return KEYS.has(key) ? (key as ReviewKey) : null;
}

/**
 * The review queue: roles and facts in page order, one of them active. While focus is inside the
 * queue, Y says that's right (confirms), F fixes (edits) and L leaves out (rejects) the active
 * item, and J and K move to the next and previous item. The keys work only with focus inside,
 * never in a field or an open question, with Ctrl, Meta or Alt held, or on key repeat, which keeps
 * them clear of speech input and typing elsewhere on the page (WCAG 2.1.4); the buttons stay the
 * main way to review.
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
    const key = reviewKeyOf(e, container.current);
    if (!key) return;
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
    const run = key === "y" ? actions?.confirm : key === "f" ? actions?.edit : actions?.reject;
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
