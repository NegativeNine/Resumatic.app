import { Tick } from "./ui";

const STEPS = [
  { id: "analyze", label: "Read the job description" },
  { id: "select", label: "Choose your most relevant confirmed facts" },
  { id: "write", label: "Write lines from those facts" },
  { id: "verify", label: "Check every line against its facts" },
  { id: "finish", label: "Put the resume together" },
] as const;

/** Progress of a running Tailor run. `step` is the last step that finished. */
export function TailorProgress({ step, dispatchUncertain, cancellationPending }: { step: string | null; dispatchUncertain?: boolean; cancellationPending?: boolean }) {
  if (cancellationPending)
    return (
      <section className="card" aria-labelledby="progress-heading">
        <h2 id="progress-heading">Tailoring your resume</h2>
        <p role="status">
          Cancellation is pending. Tailoring may still start or carry on for a moment, so check back soon.
        </p>
      </section>
    );
  if (dispatchUncertain)
    return (
      <section className="card" aria-labelledby="progress-heading">
        <h2 id="progress-heading">Tailoring your resume</h2>
        <p role="status">
          Your request was saved, but Resumatic can’t confirm that tailoring started.
          It may still begin, so check back soon.
        </p>
      </section>
    );
  const done = STEPS.findIndex((s) => s.id === step) + 1;
  const current = Math.min(done, STEPS.length - 1);

  return (
    <section className="card" aria-labelledby="progress-heading">
      <h2 id="progress-heading">Tailoring your resume</h2>
      <p className="meta">
        You can leave this page. Tailoring carries on, and the resume will be waiting under Jobs.
      </p>
      <p className="app-step-count" role="status">
        Step {current + 1} of {STEPS.length}: {STEPS[current].label}
      </p>
      <ol className="rs-steps app-steps">
        {STEPS.map((s, i) => {
          const state = i < done ? "done" : i === current ? "current" : "todo";
          return (
            <li key={s.id} className={`rs-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
              <Tick state={state === "done" ? "backed" : state === "current" ? "working" : "todo"} />
              <span>
                {s.label}
                {state === "done" && <span className="rs-visually-hidden"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
