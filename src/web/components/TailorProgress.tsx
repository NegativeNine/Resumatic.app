const STEPS = [
  { id: "analyze", label: "Read the job description" },
  { id: "select", label: "Choose your most relevant confirmed facts" },
  { id: "write", label: "Write lines from those facts" },
  { id: "verify", label: "Check every line against its facts" },
  { id: "finish", label: "Put the resume together" },
] as const;

/** Progress of a running Tailor run. `step` is the last step that finished. */
export function TailorProgress({ step }: { step: string | null }) {
  const done = STEPS.findIndex((s) => s.id === step) + 1;
  const current = Math.min(done, STEPS.length - 1);

  return (
    <section className="card" aria-labelledby="progress-heading">
      <h2 id="progress-heading">Tailoring your resume</h2>
      <p className="meta">
        You can leave this page. Tailoring carries on, and the resume will be waiting under Applications.
      </p>
      <p className="step-count" role="status">
        Step {current + 1} of {STEPS.length}: {STEPS[current].label}
      </p>
      <ol className="plain-list steps">
        {STEPS.map((s, i) => {
          const state = i < done ? "done" : i === current ? "current" : "todo";
          return (
            <li key={s.id} className={state} aria-current={state === "current" ? "step" : undefined}>
              <span className="marker" aria-hidden="true" />
              {s.label}
              {state === "done" && <span className="visually-hidden"> (done)</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
