import { PlaceholderSection } from "../../components/Placeholder";
import { SavedAnswers } from "../../components/SavedAnswers";
import { PageHeader } from "../../components/ui";

// Jobs' pages made from what is built today, until the Jobs stage builds them. Saved answers are
// on Account too until then.

/** Jobs › Applications › Rules and answers: the rules to come, then the saved answers that work now. */
export function RulesInterim() {
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
