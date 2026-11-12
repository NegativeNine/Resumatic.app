import { useState } from "react";
import { ADD_SOURCE_START, AddSource, type AddSourceState } from "../../components/AddSource";
import { SourceList } from "../../components/SourceList";
import { ErrorNote, Loading, PageHeader } from "../../components/ui";
import { useResource } from "../../hooks";
import { isReading, loadVault } from "../../vault";
import "../../styles/rooms/facts.css";

/** Facts › Your files: every file and text added, how its reading went, and adding another. */
export function FactsSources() {
  const vault = useResource(loadVault, isReading);
  const [adding, setAdding] = useState<AddSourceState>(ADD_SOURCE_START);
  return (
    <>
      <PageHeader title="Your files">
        The files and text your facts were read from. Each stays here as you gave it, and you can download it at any
        time.
      </PageHeader>
      {vault.error && <ErrorNote message={vault.error} onRetry={vault.reload} />}
      {!vault.data && !vault.error && <Loading>Loading your files…</Loading>}
      {vault.data && (
        <div className="app-cols">
          <div className="app-main">
            <section className="rs-panel facts-files" aria-labelledby="facts-files-heading">
              <h2 id="facts-files-heading" className="rs-h3">
                What you’ve added
              </h2>
              <SourceList vault={vault.data} reload={vault.reload} />
            </section>
          </div>
          <aside className="app-side" aria-labelledby="facts-add-heading">
            <section className="rs-panel">
              <h2 id="facts-add-heading" className="rs-h3">
                Add a file
              </h2>
              <AddSource onAdded={vault.reload} state={adding} onState={setAdding} />
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
