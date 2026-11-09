import { Review } from "../components/Review";
import { SourceList } from "../components/SourceList";
import { Uploader } from "../components/Uploader";
import { ErrorNote, Loading, PageHeader, Tick } from "../components/ui";
import { useResource } from "../hooks";
import { isReading, loadVault, type Vault } from "../vault";

const isFirstRun = (vault: Vault) => vault.sources.length === 0 && vault.roles.length === 0 && vault.facts.length === 0;

/** Facts: the sources rail beside the review queue, or one big dropzone before the first upload. */
export function SourcesPage() {
  const vault = useResource(loadVault, isReading);
  const firstRun = vault.data ? isFirstRun(vault.data) : false;

  return (
    <>
      <PageHeader title="Facts">
        Upload your resume or CV. Resumatic breaks it into roles and facts, each with the exact words it came from.
        Only the facts you confirm are ever used in a tailored resume.
      </PageHeader>

      {vault.error && <ErrorNote message={vault.error} onRetry={vault.reload} />}
      {!vault.data && !vault.error && <Loading>Loading your sources and facts…</Loading>}
      {vault.data && firstRun && (
        <>
          <section className="facts-first-run" aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="rs-visually-hidden">
              Add a source
            </h2>
            <Uploader onUploaded={vault.reload} size="first-run" />
          </section>
          <Review vault={vault.data} reload={vault.reload} />
          <WhatHappensNext />
        </>
      )}
      {vault.data && !firstRun && (
        <div className="facts-layout">
          <aside className="facts-rail" aria-labelledby="sources-heading">
            <h2 id="sources-heading" className="rs-h3">
              Your sources
            </h2>
            <Uploader onUploaded={vault.reload} />
            <SourceList vault={vault.data} reload={vault.reload} />
          </aside>
          <div className="facts-main">
            <Review vault={vault.data} reload={vault.reload} />
          </div>
        </div>
      )}
    </>
  );
}

const STEPS = [
  {
    title: "Resumatic reads it",
    text: "It finds your roles and the facts in each one, and keeps the exact words every fact came from.",
  },
  {
    title: "You confirm what’s true",
    text: "Check each fact against its words. Confirm it, fix it, or reject it. Nothing is used until you confirm it.",
  },
  {
    title: "You tailor it to a job",
    text: "Paste a job description, and get a resume built only from your confirmed facts, with every line checked.",
  },
];

function WhatHappensNext() {
  return (
    <section className="facts-next" aria-labelledby="next-heading">
      <h2 id="next-heading" className="rs-h2">
        What happens next
      </h2>
      <ol className="facts-next__steps">
        {STEPS.map((step) => (
          <li key={step.title}>
            <Tick state="todo" />
            <h3 className="rs-h3">{step.title}</h3>
            <p className="rs-p">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
