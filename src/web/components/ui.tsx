import { useState, type ReactNode } from "react";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children && <p className="lede">{children}</p>}
    </div>
  );
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
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
    <div className="alert alert-block" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="small" onClick={retry} disabled={retrying}>
          {retrying ? "Trying again…" : "Try again"}
        </button>
      )}
    </div>
  );
}

/** A failed action, shown under the control that started it. */
export function ActionError({ message }: { message: string | null }) {
  return message ? (
    <p className="alert" role="alert">
      {message}
    </p>
  ) : null;
}

export function Badge({ tone, title, children }: { tone: string; title?: string; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** A verbatim quote from a source, the evidence behind a fact. */
export function Quote({ text, caption }: { text: string; caption?: string }) {
  return (
    <figure className="quote">
      <blockquote>{text.trim()}</blockquote>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function CharCount({ id, length, max }: { id: string; length: number; max: number }) {
  const over = length - max;
  return (
    <p id={id} className={over > 0 ? "char-count over" : "char-count"}>
      {over > 0
        ? `${over.toLocaleString()} characters over the ${max.toLocaleString()} limit`
        : `${length.toLocaleString()} of ${max.toLocaleString()} characters`}
    </p>
  );
}
