import { PlaceholderSection } from "../../components/Placeholder";
import { SavedAnswers } from "../../components/SavedAnswers";
import { PageHeader } from "../../components/ui";

/** Jobs › Applications › Rules and answers: the rules to come, then the saved answers that work now. */
export function RulesPage() {
  return (
    <>
      <PageHeader title="Rules and answers">
        What Resumatic may prepare for you, and the answers it may reuse. Nothing is sent until you say so.
      </PageHeader>
      <div className="stack">
        <PlaceholderSection name="rules" />
        <SavedAnswers />
      </div>
    </>
  );
}
