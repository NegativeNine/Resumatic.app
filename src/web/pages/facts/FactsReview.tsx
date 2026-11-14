import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { GroupIdenticalCopies } from "../../components/CopyControls";
import { ADD_SOURCE_START, AddSource, type AddSourceState } from "../../components/AddSource";
import { isFirstRun, WhatHappensNext } from "../../components/facts/FirstRun";
import { FactQuestion, RoleQuestion } from "../../components/facts/Question";
import { FilePanel } from "../../components/facts/SourceText";
import { ROLE_NOTE, UP_NEXT_MAX, UpNext } from "../../components/facts/UpNext";
import { PlaceholderSection } from "../../components/Placeholder";
import { reviewKeyOf, type ReviewKey } from "../../components/ReviewQueue";
import { EmptyState, ErrorNote, Glyph, Loading, PageHeader } from "../../components/ui";
import { useResource } from "../../hooks";
import { href } from "../../router";
import { isReading, loadVault, reviewQuestions, type ReviewQuestion, type Vault } from "../../vault";
import "../../styles/rooms/facts.css";

// Facts › To check: one question at a time, beside the file it came from. The questions are
// reviewQuestions(), the groups Today counts, in the order the list shows them. Answering moves
// to the next one. The keys only ever press this question's own enabled buttons, so they can do
// nothing the buttons can't, and nothing at all while an editor or a question is open.

const QUESTION_ID = "facts-question";
const HEADING_ID = "facts-question-heading";
const TEXT_ID = "facts-question-text";

/** What each key presses: an answer, or Skip for now and Back. */
const KEY_TARGET: Readonly<Record<ReviewKey, string>> = {
  y: "[data-review-action='confirm']",
  f: "[data-review-action='edit']",
  l: "[data-review-action='reject']",
  j: "[data-review-nav='next']",
  k: "[data-review-nav='back']",
};

/**
 * The question to show: the one chosen while it is still asked, otherwise the first one after it
 * in the order last shown that is still asked, then the nearest before it, then the first.
 */
export function nextQuestionKey(chosen: string | null, keys: readonly string[], previous: readonly string[]): string | null {
  const asked = new Set(keys);
  if (chosen !== null && asked.has(chosen)) return chosen;
  const at = chosen === null ? -1 : previous.indexOf(chosen);
  if (at >= 0) {
    for (let i = at + 1; i < previous.length; i++) if (asked.has(previous[i]!)) return previous[i]!;
    for (let i = at - 1; i >= 0; i--) if (asked.has(previous[i]!)) return previous[i]!;
  }
  return keys[0] ?? null;
}

export function FactsReview() {
  const vault = useResource(loadVault, isReading);
  // Before the first upload the page opens on one big dropzone, and keeps it until it is left, so
  // a file read in this visit is asked about under it. Later data never turns it on.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  if (firstRun === null && vault.data) setFirstRun(isFirstRun(vault.data));
  // Kept here, not in AddSource, as the paste being written must outlive a reload.
  const [adding, setAdding] = useState<AddSourceState>(ADD_SOURCE_START);

  return (
    <>
      <div className="app-head">
        <PageHeader title="To check">
          Resumatic found these in your files. Say which are right. Nothing is used until you do.
        </PageHeader>
        <a className="rs-btn" href={href.files}>
          <Glyph name="upload" />
          Add a file
        </a>
      </div>
      {vault.error && <ErrorNote message={vault.error} onRetry={vault.reload} />}
      {!vault.data && !vault.error && <Loading>Loading your files and facts…</Loading>}
      {vault.data && firstRun && (
        <section className="facts-first-run" aria-labelledby="upload-heading">
          <h2 id="upload-heading" className="rs-visually-hidden">
            Add a file
          </h2>
          <AddSource onAdded={vault.reload} size="first-run" state={adding} onState={setAdding} />
        </section>
      )}
      {vault.data && <GroupIdenticalCopies enabled={[...vault.data.roles, ...vault.data.facts].some((item) => !!item.copyReview)} reload={vault.reload} />}
      {vault.data && <Check live={vault.data} reload={vault.reload} />}
      {vault.data && firstRun && <WhatHappensNext />}
    </>
  );
}

function Check({ live, reload }: { live: Vault; reload: () => Promise<Vault | undefined> }) {
  // While an editor is open the question holds the vault it showed, so a refresh can't move or
  // remove the item and lose its draft. The file beside it stays live.
  const [held, setHeld] = useState<Vault | null>(null);
  const latest = useRef(live);
  latest.current = live;
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"everything" | "roles">("everything");
  const [showFile, setShowFile] = useState(false);
  const section = useRef<HTMLElement>(null);
  const itemArea = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const fileId = useId();
  const displayed = held ?? live;
  const editing = held !== null;
  const filenames = useMemo(() => new Map(displayed.sources.map((s) => [s.id, s.filename] as const)), [displayed.sources]);
  const questions = useMemo(() => reviewQuestions(displayed), [displayed]);
  const keys: string[] = questions.map((question) => question.key);

  // The question shown is chosen by key, so a refresh keeps it; when it is answered, the one
  // after it in the order last shown takes its place.
  const [chosen, setChosen] = useState<string | null>(null);
  const order = useRef<readonly string[]>([]);
  const currentKey = nextQuestionKey(chosen, keys, order.current);
  useEffect(() => {
    order.current = keys;
    if (currentKey !== chosen) setChosen(currentKey);
  });
  const index = currentKey === null ? -1 : keys.indexOf(currentKey);
  const question: ReviewQuestion | null = index >= 0 ? questions[index]! : null;
  const following = index >= 0 ? [...questions.slice(index + 1), ...questions.slice(0, index)].slice(0, UP_NEXT_MAX) : [];

  // Skip and Back show another question in place. If focus was on the item that goes, or on Back
  // as it reaches the first question and is disabled, it moves to the question's section, so the
  // keys keep working.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    section.current?.focus();
  }, [currentKey]);

  const onEditingChange = useCallback((active: boolean) => {
    setHeld(active ? latest.current : null);
  }, []);
  const onBusyChange = useCallback((value: boolean) => setBusy(value), []);
  const locked = editing || busy;

  function move(by: 1 | -1) {
    if (index < 0) return;
    const target = (index + by + keys.length) % keys.length;
    const focused = document.activeElement;
    const onItem = focused instanceof Node && itemArea.current?.contains(focused) === true;
    const onDisabledBack = focused instanceof HTMLElement && focused.dataset.reviewNav === "back" && target === 0;
    refocus.current = onItem || onDisabledBack;
    setChosen(keys[target]!);
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const here = section.current;
    const key = reviewKeyOf(e, here);
    if (!key || !here) return;
    // An open editor or question answers only to its own controls.
    if (here.querySelector("form, .rs-well")) return;
    const button = here.querySelector<HTMLButtonElement>(KEY_TARGET[key]);
    if (!button || button.disabled) return;
    e.preventDefault();
    button.click();
  }

  const meta =
    question === null
      ? null
      : question.kind === "role"
        ? `${index + 1} of ${keys.length}. ${ROLE_NOTE}`
        : question.role
          ? `${index + 1} of ${keys.length}. From your time ${question.role.title ? `as ${question.role.title} at` : "at"} ${question.role.org}.`
          : `${index + 1} of ${keys.length}. Not tied to a role.`;

  return (
    <>
      <fieldset className="rs-filter facts-filter" disabled={locked}>
        <legend>What to check</legend>
        {(
          [
            ["everything", "Everything"],
            ["roles", "Roles and facts"],
          ] as const
        ).map(([value, label]) => (
          <label key={value}>
            <input type="radio" name="facts-check-filter" checked={filter === value} onChange={() => setFilter(value)} />
            <span className="rs-filter__opt">
              {label} <span className="rs-filter__count">{keys.length}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {held && (
        <p role="status" className="rs-hint facts-paused">
          Checking is paused while you fix this. New changes appear when you close the editor. Your draft will be lost if
          you leave or reload this page.
        </p>
      )}
      <div className="facts-check">
        <section
          id={QUESTION_ID}
          ref={section}
          className="rs-panel facts-ask"
          tabIndex={-1}
          aria-labelledby={HEADING_ID}
          aria-describedby={question && !editing ? TEXT_ID : undefined}
          onKeyDown={onKeyDown}
        >
          {question && meta && (
            <div className="app-row facts-ask__meta">
              <p className="rs-meta">{meta}</p>
              <span className="app-inline">
                <button
                  type="button"
                  className="rs-linkbtn"
                  aria-keyshortcuts="K"
                  data-review-nav="back"
                  disabled={index === 0 || locked}
                  onClick={() => move(-1)}
                >
                  <Glyph name="back" />
                  Back
                </button>
                <button
                  type="button"
                  className="rs-linkbtn"
                  aria-keyshortcuts="J"
                  data-review-nav="next"
                  disabled={keys.length <= 1 || locked}
                  onClick={() => move(1)}
                >
                  Skip for now
                </button>
              </span>
            </div>
          )}
          <h2 id={HEADING_ID} className={question ? "rs-h2" : "rs-visually-hidden"}>
            {question ? "Is this right?" : "Nothing to check"}
          </h2>
          <div ref={itemArea}>
            {question === null ? (
              <NothingToCheck vault={displayed} />
            ) : question.kind === "fact" ? (
              <FactQuestion
                key={question.key}
                question={question}
                filenames={filenames}
                roles={displayed.roles}
                reload={reload}
                section={section}
                textId={TEXT_ID}
                onEditingChange={onEditingChange}
                onBusyChange={onBusyChange}
              />
            ) : (
              <RoleQuestion
                key={question.key}
                question={question}
                filenames={filenames}
                roles={displayed.roles}
                reload={reload}
                section={section}
                textId={TEXT_ID}
                onEditingChange={onEditingChange}
                onBusyChange={onBusyChange}
              />
            )}
          </div>
          {question && (
            <button
              type="button"
              className="rs-linkbtn facts-ask__where"
              aria-expanded={showFile}
              aria-controls={fileId}
              onClick={() => setShowFile(!showFile)}
            >
              {showFile ? "Hide where this came from" : "See where this came from"}
            </button>
          )}
        </section>
        <FilePanel id={fileId} open={showFile} question={question} live={live} reload={reload} focusAfter={() => section.current} />
        <UpNext questions={following} />
        <div className="facts-kinds">
          <PlaceholderSection name="factsCheckKinds" />
        </div>
      </div>
    </>
  );
}

function NothingToCheck({ vault }: { vault: Vault }) {
  if (isReading(vault)) {
    return <EmptyState>Resumatic is reading your file. What it finds will appear here for you to check.</EmptyState>;
  }
  if (vault.roles.length === 0 && vault.facts.length === 0) {
    return (
      <EmptyState>
        Nothing to check yet. Upload a resume or CV, or <a href={href.factsAll}>add a fact yourself</a>.
      </EmptyState>
    );
  }
  return (
    <EmptyState title="You’re all caught up">
      Nothing is waiting for you to check. Next, <a href={href.jobs}>add a job</a> and tailor a resume to it.
    </EmptyState>
  );
}
