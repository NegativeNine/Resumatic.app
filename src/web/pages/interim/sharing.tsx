import { CoachSharingTools } from "../../components/AccountTools";
import { CardPreviewSection } from "../../components/CardPreview";
import { ConnectedApps } from "../../components/ConnectedApps";
import { PlaceholderSection } from "../../components/Placeholder";
import { JobPreferences } from "../../components/Preferences";
import { OwnerComments } from "../../components/ShareComments";
import { PageHeader } from "../../components/ui";
import { useSession } from "../../session";

// Sharing's pages made from what Account shows today, until the Sharing stage builds them. Each
// section is on Account too until then, and works the same in both places.

/** Sharing › Overview: for now, what a coach has written on the copies shared with them. */
export function SharingInterim() {
  return (
    <>
      <PageHeader title="Sharing">Who can see what. Nothing leaves your record without your choice.</PageHeader>
      <div className="stack">
        <OwnerComments />
      </div>
    </>
  );
}

/** Sharing › Coaches: the copies shared with a coach and what was said on them. */
export function CoachesInterim() {
  return (
    <>
      <PageHeader title="Coaches">
        Share a fixed copy with someone who’s helping you. They can read it and comment on it. Only you can change
        your resume.
      </PageHeader>
      <div className="stack">
        <CoachSharingTools />
        <OwnerComments />
        <PlaceholderSection name="liveAccess" />
      </div>
    </>
  );
}

/** Sharing › Recruiters: what the person is looking for, and the card a recruiter would see where it is switched on. */
export function RecruitersInterim() {
  const { me } = useSession();
  return (
    <>
      <PageHeader title="Recruiters">What you’re looking for, kept in your record and shown to nobody.</PageHeader>
      <div className="stack">
        <JobPreferences />
        {me.capabilities?.cardPreview && <CardPreviewSection />}
        <PlaceholderSection name="recruitersVisibility" />
      </div>
    </>
  );
}

/** Sharing › Connected apps. Reached only where connected apps are switched on. */
export function AppsInterim() {
  return (
    <>
      <PageHeader title="Connected apps">
        Let an assistant or a tool you use work with your record. It can do only what you allow, and only for 30 days at a
        time.
      </PageHeader>
      <div className="stack">
        <ConnectedApps />
      </div>
    </>
  );
}
