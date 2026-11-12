import type { ReactNode } from "react";
import { Glyph } from "../ui";

// The design system's MoreChoices: a closed row under a group of settings, holding the choices most
// people never change. Its hint says what is inside, so nobody has to open it to find out. Nothing
// that protects the person goes inside: what is shared, what something costs and how to stop it
// stay in view.

export function MoreChoices({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <details className="rs-more">
      <summary>
        <Glyph name="chevron" />
        More choices <span className="rs-more__hint">{hint}</span>
      </summary>
      <div className="rs-more__body">{children}</div>
    </details>
  );
}
