import { useState, type ReactNode } from "react";
import type { LineStatus, ResumeState, ReviewState, SourceState } from "../../shared/api";

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

/**
 * The design system's plain status tones. Green (`backed`) means it is backed or done; amber
 * (`needs-you`) means it waits for the person; `note` is a plain note about what happened; `working`
 * is work in progress; `problem` is a failure. `beta` and `status` are neutral outlines: the beta
 * label, and a job's own tracking status, which is the person's record, not a check result.
 * Every mark keeps its word: the colour only backs it up.
 */
export type MarkTone = "backed" | "needs-you" | "note" | "working" | "problem" | "beta" | "status";

/** A status mark (StatusMark): the state of a fact, role, file, resume or line, in words. */
export function Badge({ tone, title, children }: { tone: MarkTone; title?: string; children: ReactNode }) {
  return (
    <span className={`rs-mark rs-mark--${tone}`} title={title}>
      {children}
    </span>
  );
}

/** The tick column's states: a green check once it is backed, an amber dot while it waits for you. */
export type TickState = "backed" | "needs-you" | "left-out" | "working" | "problem" | "todo";

const TICK_GLYPH: Partial<Record<TickState, GlyphName>> = {
  backed: "check",
  "left-out": "cross",
  problem: "alert",
};

/** The tone for a fact's or role's review state: To check waits for you, Confirmed is backed, Left out is a note. */
export const REVIEW_MARK: Readonly<Record<ReviewState, MarkTone>> = { proposed: "needs-you", confirmed: "backed", rejected: "note" };

/** The tick for a fact's or role's review state. */
export const REVIEW_TICK: Readonly<Record<ReviewState, TickState>> = { proposed: "needs-you", confirmed: "backed", rejected: "left-out" };

/** The tone for what the check did to a resume line: only a line backed as written is green. */
export const LINE_MARK: Readonly<Record<LineStatus, MarkTone>> = {
  kept: "backed",
  repaired: "note",
  replaced: "note",
  edited: "note",
};

/** The tone for a run's state: a file being read, a resume, a cover letter or interview preparation. */
export const RUN_MARK: Readonly<Record<ResumeState | SourceState, MarkTone>> = { queued: "working", running: "working", ready: "backed", failed: "problem" };

/** The tick column: an amber dot while it waits for you, a green check once it is backed. */
export function Tick({ state, label }: { state: TickState; label?: string }) {
  const glyph = TICK_GLYPH[state];
  return (
    <span className={`rs-tick rs-tick--${state}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {glyph && <Glyph name={glyph} />}
    </span>
  );
}

/**
 * A verbatim quote from a file: the words a fact came from. It is upright, in the interface face,
 * with the quote icon beside it, and the quoted words sit on backed-soft, because green means backed.
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
  /** A few words around the quote in its file, shown muted on either side. */
  context?: { before: string; after: string } | null;
}) {
  const classes = ["rs-quote", size === "sm" ? "rs-quote--sm" : "", context ? "rs-quote--context" : ""].filter(Boolean);
  return (
    <figure className={classes.join(" ")}>
      <Glyph name="quote" />
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
