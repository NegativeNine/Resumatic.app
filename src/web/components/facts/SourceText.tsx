import { useEffect, useMemo, useRef } from "react";
import type { FactView, RoleView } from "../../../shared/api";
import { api } from "../../api";
import { formatDate } from "../../format";
import type { Reload } from "../../hooks";
import { sourceReviewSummaries, type ReviewQuestion, type Vault } from "../../vault";
import { ConfirmAll } from "../SourceList";
import { Badge, ErrorNote, Loading } from "../ui";
import { sourceRuns, type SourceMark, type Tone } from "./source-runs";
import { useSourceText } from "./useSourceText";

// The file beside the question on To check: the whole text Resumatic read from it, with the words
// the current item rests on highlighted and the words behind its other roles and facts underlined,
// amber for still to check and green for confirmed. The text is the person's own upload, shown as
// text and never as markup. It reads the vault as it is now, so Confirm all, which changes it, is
// shown at once while the question keeps what it showed.

/** Each mark's word, read out before its text, so nothing is said by colour alone. */
const WORD: Readonly<Record<Exclude<Tone, "current">, string>> = {
  waiting: "To check: ",
  backed: "Confirmed: ",
};

/** What the current item is called in the file's words and in the legend. */
type ItemKind = ReviewQuestion["kind"];
const CURRENT_WORD: Readonly<Record<ItemKind, string>> = { fact: "This fact: ", role: "This role: " };

/**
 * The file's text, marked. Only the box scrolls, and it brings the current mark into view when
 * `at` changes: a new item, or the panel shown on a phone, where it was hidden and couldn't
 * scroll. A refresh of the vault leaves the box where the person scrolled it.
 */
export function SourceText({
  markdown,
  marks,
  at,
  kind = "fact",
}: {
  markdown: string;
  marks: readonly SourceMark[];
  at: string;
  kind?: ItemKind;
}) {
  const box = useRef<HTMLPreElement>(null);
  const runs = useMemo(() => sourceRuns(markdown, marks), [markdown, marks]);
  useEffect(() => {
    const pre = box.current;
    const mark = pre?.querySelector<HTMLElement>("mark");
    if (pre && mark) pre.scrollTop = Math.max(0, mark.offsetTop - pre.clientHeight / 3);
  }, [at, markdown]);
  return (
    <pre ref={box} className="facts-file__text" tabIndex={0}>
      {runs.map((run, i) =>
        run.tone === null ? (
          run.text
        ) : run.tone === "current" ? (
          <mark key={i} className="rs-hl">
            <span className="rs-visually-hidden">{CURRENT_WORD[kind]}</span>
            {run.text}
          </mark>
        ) : (
          <span key={i} className={`facts-u--${run.tone}`}>
            <span className="rs-visually-hidden">{WORD[run.tone]}</span>
            {run.text}
          </span>
        ),
      )}
    </pre>
  );
}

function Legend({ kind }: { kind: ItemKind }) {
  return (
    <ul className="facts-legend">
      <li>
        <span className="facts-legend__key facts-legend__key--current" aria-hidden="true" />
        The words behind the {kind} you’re checking
      </li>
      <li>
        <span className="facts-legend__key facts-legend__key--waiting" aria-hidden="true" />
        Behind a fact that’s still to check
      </li>
      <li>
        <span className="facts-legend__key facts-legend__key--backed" aria-hidden="true" />
        Behind a fact you’ve confirmed
      </li>
    </ul>
  );
}

/**
 * The panel for the current question's file. `held` is what the question shows; `live` is the
 * vault now. On a phone the panel is hidden until "See where this came from" opens it.
 */
export function FilePanel({
  id,
  open,
  question,
  live,
  reload,
  focusAfter,
}: {
  id: string;
  open: boolean;
  question: ReviewQuestion | null;
  live: Vault;
  reload: Reload;
  focusAfter: () => HTMLElement | null;
}) {
  const item: RoleView | FactView | null = question ? (question.kind === "fact" ? question.fact : question.role) : null;
  const source = item?.sourceId ? (live.sources.find((s) => s.id === item.sourceId) ?? null) : null;
  const text = useSourceText(source?.id ?? null);
  const marks = useMemo(() => {
    if (!question || !item || !source) return [];
    const copies: (RoleView | FactView)[] = [item, ...question.duplicates];
    const current = new Set(copies.map((copy) => copy.id));
    const others = [...live.roles, ...live.facts].filter((other) => other.sourceId === source.id && !current.has(other.id) && other.state !== "rejected");
    return [
      ...copies.filter((copy) => copy.sourceId === source.id).map((copy): SourceMark => ({ span: copy.span, quote: copy.quote, tone: "current" })),
      ...others.map((other): SourceMark => ({ span: other.span, quote: other.quote, tone: other.state === "proposed" ? "waiting" : "backed" })),
    ];
  }, [question, item, source, live.roles, live.facts]);

  if (!question) return null;
  const className = open ? "rs-panel facts-file is-open" : "rs-panel facts-file";
  if (!source) {
    return (
      <aside id={id} className={className} aria-label="Where this came from">
        <p className="rs-meta">This one came from no file.</p>
      </aside>
    );
  }

  const name = source.filename.replace(/\.ocr\.json$/i, "");
  const toCheck = sourceReviewSummaries(live).get(source.id)?.proposedIds ?? [];
  const revisions = Object.fromEntries([...live.roles, ...live.facts].map((entry) => [entry.id, entry.revision ?? 1]));
  const headingId = `${id}-heading`;
  return (
    <aside id={id} className={className} aria-labelledby={headingId}>
      <div className="app-row">
        <h2 id={headingId} className="rs-h3 facts-file__name">
          {name}
        </h2>
        {toCheck.length > 0 ? <Badge tone="needs-you">{toCheck.length} to check</Badge> : <Badge tone="backed">All checked</Badge>}
      </div>
      <p className="rs-meta">
        The text Resumatic read from your file. Added {formatDate(source.createdAt)}.{" "}
        {source.origin === "ocr" ? (
          source.parentSourceId && <a href={api.sourceFileUrl(source.parentSourceId)}>Download original PDF</a>
        ) : (
          <a href={api.sourceFileUrl(source.id)}>Download original</a>
        )}
      </p>
      {text.error ? (
        <ErrorNote message={text.error} onRetry={text.retry} />
      ) : text.markdown === undefined ? (
        <Loading>Opening your file…</Loading>
      ) : (
        <SourceText markdown={text.markdown} marks={marks} at={`${question.key}:${open ? "open" : "shut"}`} kind={question.kind} />
      )}
      <Legend kind={question.kind} />
      {toCheck.length > 0 && (
        <div className="facts-file__all">
          {/* Keyed by file, so a question about another file never inherits this one's open question. */}
          <ConfirmAll key={source.id} filename={name} ids={toCheck} revisions={revisions} reload={reload} focusAfter={focusAfter} />
          <p className="rs-hint">Only do this once you’ve checked every one.</p>
        </div>
      )}
    </aside>
  );
}
