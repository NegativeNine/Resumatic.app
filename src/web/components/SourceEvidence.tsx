import { useId, useState } from "react";
import { api } from "../api";
import { useAction } from "../hooks";
import { validSpan } from "./facts/source-runs";
import { ActionError } from "./ui";
import "./source-evidence.css";

/** Source text is rendered as text, including any Markdown/HTML in the upload. */
export function SourceEvidence({
  sourceId,
  quote,
  span,
}: {
  sourceId: string;
  quote: string;
  span: [number, number];
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<{
    markdown: string;
    revisionId: string;
  } | null>(null);
  const { run, pending, error } = useAction();
  const panelId = useId();
  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!source)
      await run(async () => {
        setSource(await api.sourceText(sourceId));
      });
  }
  const valid = source !== null && validSpan(source.markdown, span, quote);
  const before = source?.markdown.slice(Math.max(0, span[0] - 600), span[0]);
  const after = source?.markdown.slice(
    span[1],
    Math.min(source.markdown.length, span[1] + 600),
  );
  return (
    <div className="source-evidence">
      <button
        type="button"
        className="small quiet"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={pending}
        onClick={() => void toggle()}
      >
        {pending
          ? "Opening file…"
          : open
            ? "Hide where this came from"
            : "See where this came from"}
      </button>
      {open && (
        <div id={panelId} className="source-context" aria-live="polite">
          {valid ? (
            <pre aria-label="The file’s text, with the quoted words highlighted">
              {span[0] > 600 ? "…" : ""}
              {before}
              <mark>{quote}</mark>
              {after}
              {source!.markdown.length > span[1] + 600 ? "…" : ""}
            </pre>
          ) : (
            source && (
              <p className="hint">
                The saved quote is shown above. Its place in the file couldn’t be
                found, so nothing is highlighted.
              </p>
            )
          )}
          <ActionError message={error} />
        </div>
      )}
    </div>
  );
}
