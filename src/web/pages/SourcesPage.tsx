import { Review } from "../components/Review";
import { SourceList } from "../components/SourceList";
import { Uploader } from "../components/Uploader";
import { ErrorNote, Loading, PageHeader } from "../components/ui";
import { useResource } from "../hooks";
import { isReading, loadVault } from "../vault";

export function SourcesPage() {
  const vault = useResource(loadVault, isReading);

  return (
    <>
      <PageHeader title="Facts">
        Upload your resume or CV. Resumatic breaks it into roles and facts, each with the exact words it came from.
        Only the facts you confirm are ever used in a tailored resume.
      </PageHeader>

      <section className="section" aria-labelledby="upload-heading">
        <h2 id="upload-heading">Add a source</h2>
        <Uploader onUploaded={vault.reload} />
      </section>

      {vault.error && <ErrorNote message={vault.error} onRetry={vault.reload} />}
      {!vault.data && !vault.error && <Loading>Loading your sources and facts…</Loading>}
      {vault.data && (
        <>
          <SourceList vault={vault.data} reload={vault.reload} />
          <Review vault={vault.data} reload={vault.reload} />
        </>
      )}
    </>
  );
}
