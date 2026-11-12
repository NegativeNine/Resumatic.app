import { useId, type ReactNode } from "react";
import { Glyph } from "./ui";

// The states a page is in when it can't show what it is for. Working is `Loading` for a read, and a
// run's working mark with its status line. Failing is `ErrorNote` with Try again for a failed load,
// and `ActionError` under the control that failed. The two here are the others: something that has
// ended or isn't available, named under a heading of its own, and a stop, such as a limit or a
// refusal, with at most one thing to do about it. Each says what happened, then what to do.

/**
 * Something that has ended or isn't available, in place of what the page would show: a heading
 * that names what happened, the sentence that says what to do, and at most one way on. `level` is 1
 * where the card is the whole page, as on a shared copy that can't be opened.
 */
export function StateCard({ title, level = 2, children, action }: { title: string; level?: 1 | 2; children: ReactNode; action?: ReactNode }) {
  const id = useId();
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <section className="rs-panel app-state-card" aria-labelledby={id}>
      <Heading id={id} className="rs-h3">
        {title}
      </Heading>
      <p className="rs-meta">{children}</p>
      {action}
    </section>
  );
}

/**
 * A stop: a limit reached or a refusal, said as an alert with at most one action beside it, such as
 * a refused sign-in or a plan with no documents left.
 */
export function Stopped({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <p className="rs-msg rs-msg--error" role="alert">
      <Glyph name="alert" />
      <span className="rs-msg__text">{children}</span>
      {action}
    </p>
  );
}
