import { useEffect, useRef, useState } from "react";
import type { Today } from "../../../shared/today";
import { ADD_SOURCE_START, type AddSourceState } from "../../components/AddSource";
import { NextStep } from "../../components/today/NextStep";
import { RecentSection, WaitingSection, WorkingSection } from "../../components/today/TodaySections";
import { ByEmail, WhereThingsStand } from "../../components/today/WhereThingsStand";
import { ErrorNote, Loading, PageHeader } from "../../components/ui";
import { useSession } from "../../session";
import { useToday } from "../../today";
import { byPriority, hiddenUnits, isFirstRun, knownEvents, knownWaiting, knownWorking, listCount, nextStep } from "./rows";
import { TodayFirstRun } from "./TodayFirstRun";
import "../../styles/rooms/today.css";

/** The lede: how many things wait, in the header's count, and the promise that holds for all of them. */
function lede(n: number): string {
  const promise = "Nothing is used, sent or shared until you say so.";
  if (n === 0) return promise;
  return `${n === 1 ? "1 thing is" : `${n.toLocaleString()} things are`} waiting for you. ${promise}`;
}

/**
 * Today: the one next step, what else waits, what Resumatic is working on and what happened lately,
 * beside where each room stands. It shows the Today the shell loaded and never asks for its own, so
 * the page and the header's count agree. A failed refresh keeps the last page, with Try again above.
 */
export function TodayPage() {
  const { last, error, reload } = useToday();
  const { me } = useSession();
  // Kept here, not in the first-run view: adding the first file ends first run, and the sentence
  // saying it was added must outlive that view to open the full one.
  const [adding, setAdding] = useState<AddSourceState>(ADD_SOURCE_START);

  if (!last)
    return (
      <>
        <PageHeader title="Today" />
        {error ? <ErrorNote message={error} onRetry={reload} /> : <Loading>Loading what’s waiting for you…</Loading>}
      </>
    );

  const retry = error && <ErrorNote message={error} onRetry={reload} />;
  if (isFirstRun(last))
    return (
      <>
        <PageHeader title="Today">Three steps to a tailored resume you can stand behind. Start with the resume you have.</PageHeader>
        {retry}
        <TodayFirstRun reload={reload} adding={adding} onAdding={setAdding}>
          <Waiting today={last} next={null} />
          <WorkingSection items={knownWorking(last)} />
        </TodayFirstRun>
      </>
    );

  const next = nextStep(last);
  // Only the first-run panels set a notice, so one here is the file or text that ended first run.
  const notice = adding.notices[adding.mode] ?? adding.notices[adding.mode === "file" ? "paste" : "file"];
  return (
    <>
      <PageHeader title="Today">{lede(last.counts.today)}</PageHeader>
      {retry}
      {notice && <Added notice={notice} />}
      {next ? <NextStep item={next} /> : last.counts.today === 0 && <p className="app-today-clear">Nothing needs you right now.</p>}
      <div className="app-cols">
        <div className="app-main app-stack">
          <Waiting today={last} next={next} />
          <WorkingSection items={knownWorking(last)} />
          <RecentSection today={last} events={knownEvents(last)} />
        </div>
        <aside className="app-side app-stack" aria-label="Where things stand">
          <WhereThingsStand today={last} me={me} />
          <ByEmail me={me} />
        </aside>
      </div>
    </>
  );
}

/** Every known item but the next step, in priority order, counted in the header's units. */
function Waiting({ today, next }: { today: Today; next: Today["waiting"][number] | null }) {
  const items = [...knownWaiting(today)].sort(byPriority).filter((item) => item !== next);
  return <WaitingSection items={items} count={listCount(today, next)} more={hiddenUnits(today) > 0} />;
}

/** The sentence for what ended first run, focused once when it appears, so the person hears it. */
function Added({ notice }: { notice: string }) {
  const sentence = useRef<HTMLParagraphElement>(null);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (focused.current === notice) return;
    focused.current = notice;
    sentence.current?.focus();
  }, [notice]);
  return (
    <p className="success app-today-added" role="status" tabIndex={-1} ref={sentence}>
      {notice}
    </p>
  );
}
