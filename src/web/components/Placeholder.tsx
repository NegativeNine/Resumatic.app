import { useId } from "react";
import { PLACEHOLDERS, PLACEHOLDER_SECTIONS, type PlaceholderName, type PlaceholderSectionName } from "../placeholders";
import { Badge, PageHeader } from "./ui";

// A page or a section that isn't built yet, said plainly: its name, what it is for, that it isn't
// available, and what it waits for. It holds no control, no sample and no count, and at most one
// plain link back to a page that works.

const NOT_YET = "Not available yet";

export function PlaceholderPage({ name }: { name: PlaceholderName }) {
  const copy: (typeof PLACEHOLDERS)[PlaceholderName] = PLACEHOLDERS[name];
  return (
    <>
      <PageHeader title={copy.title}>{copy.lede}</PageHeader>
      <section className="rs-panel app-placeholder">
        <Badge tone="note">{NOT_YET}</Badge>
        <p className="app-placeholder__note">{copy.note}</p>
        {"back" in copy && (
          <p className="app-placeholder__back">
            <a href={copy.back.to}>{copy.back.label}</a>
          </p>
        )}
      </section>
    </>
  );
}

export function PlaceholderSection({ name }: { name: PlaceholderSectionName }) {
  const copy = PLACEHOLDER_SECTIONS[name];
  const id = useId();
  return (
    <section className="rs-panel app-placeholder" aria-labelledby={id}>
      <h2 id={id}>{copy.title}</h2>
      <Badge tone="note">{NOT_YET}</Badge>
      <p className="app-placeholder__note">{copy.note}</p>
    </section>
  );
}
