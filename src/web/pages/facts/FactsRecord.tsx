import { Review } from "../../components/Review";
import { ErrorNote, Loading, PageHeader } from "../../components/ui";
import { useResource } from "../../hooks";
import { isReading, loadVault } from "../../vault";
import "../../styles/rooms/facts.css";

/** Facts › All facts: everything confirmed, by role, and what was left out, with adding your own. */
export function FactsRecord() {
  const vault = useResource(loadVault, isReading);
  return (
    <>
      <PageHeader title="All facts">
        Everything you’ve confirmed, by role. A resume, a letter or a shared copy draws on these and on nothing else.
      </PageHeader>
      {vault.error && <ErrorNote message={vault.error} onRetry={vault.reload} />}
      {!vault.data && !vault.error && <Loading>Loading your facts…</Loading>}
      {vault.data && <Review vault={vault.data} reload={vault.reload} />}
    </>
  );
}
