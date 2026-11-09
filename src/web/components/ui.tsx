import { useState, type ReactNode } from "react";

// The design system's primitives, drawn with its rs- classes (styles/components.css).

/** The design system's glyphs: masks that take the text color. Always decoration. */
export type GlyphName =
  | "check"
  | "cross"
  | "caret"
  | "quote"
  | "pen"
  | "strike"
  | "alert"
  | "info"
  | "follows"
  | "upload"
  | "download"
  | "file"
  | "chevron"
  | "back";

export function Glyph({ name, className }: { name: GlyphName; className?: string }) {
  return <i className={`rs-g rs-g--${name}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1 className="rs-h1">{title}</h1>
      {children && <p className="rs-lede">{children}</p>}
    </div>
  );
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="rs-loading" role="status">
      <span className="rs-spinner" aria-hidden="true" />
      {children}
    </p>
  );
}

/** A failed load, with a way to try again. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => Promise<unknown> }) {
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="rs-msg rs-msg--error app-msg-block" role="alert">
      <Glyph name="alert" />
      <p className="rs-msg__text">{message}</p>
      {onRetry && (
        <button type="button" className="rs-btn rs-btn--sm" onClick={retry} disabled={retrying}>
          {retrying ? "Trying again…" : "Try again"}
        </button>
      )}
    </div>
  );
}

/** A failed action, shown under the control that started it. */
export function ActionError({ message }: { message: string | null }) {
  return message ? (
    <p className="rs-inline-error" role="alert">
      <Glyph name="alert" />
      <span>{message}</span>
    </p>
  ) : null;
}

/** A note about the page or a step: information, or a confirmation that something worked. */
export function Message({
  tone,
  children,
  live = true,
}: {
  tone: "info" | "success";
  children: ReactNode;
  /** Announce it to screen readers when it appears. */
  live?: boolean;
}) {
  return (
    <div className={`rs-msg rs-msg--${tone} app-msg-block`} role={live ? "status" : undefined}>
      <Glyph name={tone === "success" ? "check" : "info"} />
      <div className="rs-msg__text">{children}</div>
    </div>
  );
}

/** A short "done" line after a save, such as "Profile saved." */
export function Success({ children }: { children: ReactNode }) {
  return (
    <p className="rs-success" role="status">
      <Glyph name="check" />
      {children}
    </p>
  );
}

/** An empty list names the next step and links to it. */
export function EmptyState({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <p className="rs-empty">
      {title && <strong>{title}</strong>}
      {children}
    </p>
  );
}

/** v1 tone names that the design system calls something else. */
const MARK_TONE: Readonly<Record<string, string>> = { queued: "reading" };

/** A status mark (StatusMark): the state of a fact, role, source, resume or line, in words. */
export function Badge({ tone, title, children }: { tone: string; title?: string; children: ReactNode }) {
  return (
    <span className={`rs-mark rs-mark--${MARK_TONE[tone] ?? tone}`} title={title}>
      {children}
    </span>
  );
}

export type TickState = "proposed" | "confirmed" | "rejected" | "mine" | "running" | "failed" | "todo" | "done";

const TICK_GLYPH: Partial<Record<TickState, GlyphName>> = {
  confirmed: "check",
  done: "check",
  rejected: "strike",
  mine: "pen",
  failed: "cross",
};

/** The tick column: a dashed pencil tick until someone confirms, ink once they do. */
export function Tick({ state, label }: { state: TickState; label?: string }) {
  const glyph = TICK_GLYPH[state];
  return (
    <span className={`rs-tick rs-tick--${state}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {glyph && <Glyph name={glyph} />}
    </span>
  );
}

/**
 * A verbatim quote from a source, the evidence behind a fact. The quoted words are highlighted,
 * because yellow means the person said it, and ⊢ in the gutter reads "follows from".
 */
export function Quote({
  text,
  caption,
  size,
  context,
}: {
  text: string;
  caption?: string;
  size?: "sm";
  /** A few words around the quote in its source, shown muted on either side. */
  context?: { before: string; after: string } | null;
}) {
  const classes = ["rs-quote", size === "sm" ? "rs-quote--sm" : "", context ? "rs-quote--context" : ""].filter(Boolean);
  return (
    <figure className={classes.join(" ")}>
      <Glyph name="follows" />
      <blockquote>
        {context?.before && <span className="rs-quote__context">{context.before}</span>}
        <mark className="rs-hl">{text.trim()}</mark>
        {context?.after && <span className="rs-quote__context">{context.after}</span>}
      </blockquote>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

export function Field({
  id,
  label,
  hint,
  optional,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Marks a field that can be left empty, beside its label. */
  optional?: boolean;
  /** What is wrong with the value, shown under the control as `${id}-error`. */
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="rs-field field">
      <label className="rs-label" htmlFor={id}>
        {label}
        {optional && <span className="rs-label__optional"> (optional)</span>}
      </label>
      {children}
      {hint && (
        <p className="rs-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="rs-inline-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function CharCount({ id, length, max }: { id: string; length: number; max: number }) {
  const over = length - max;
  return (
    <p id={id} className={over > 0 ? "rs-count is-over" : "rs-count"}>
      {over > 0
        ? `${over.toLocaleString()} characters over the ${max.toLocaleString()} limit`
        : `${length.toLocaleString()} of ${max.toLocaleString()} characters`}
    </p>
  );
}
