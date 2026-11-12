import { CardPreviewSection } from "../../components/CardPreview";
import { PlaceholderSection } from "../../components/Placeholder";
import { JobPreferences } from "../../components/Preferences";
import { PageHeader } from "../../components/ui";
import { useSession } from "../../session";
import "../../styles/rooms/sharing.css";

// Sharing › Recruiters. No recruiter can find anyone yet, so being found and requests to meet are
// said plainly as not available, in view rather than behind More choices. What a recruiter would
// see is shown where the deployment has the preview on, and what the person is looking for is kept
// in their record and shown to nobody.

export function SharingRecruiters() {
  const { me } = useSession();
  return (
    <>
      <PageHeader title="Recruiters">What you’re looking for, kept in your record. No recruiter can find you today.</PageHeader>
      <div className="app-cols">
        <div className="app-main app-stack">
          <PlaceholderSection name="recruitersVisibility" />
          {me.capabilities?.cardPreview && <CardPreviewSection />}
        </div>
        <div className="app-side app-stack">
          <PlaceholderSection name="recruitersRequests" />
          <JobPreferences />
        </div>
      </div>
    </>
  );
}
