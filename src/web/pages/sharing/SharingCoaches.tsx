import { useState } from "react";
import { api } from "../../api";
import { PlaceholderSection } from "../../components/Placeholder";
import { OwnerComments } from "../../components/ShareComments";
import { CopyList, NewCopy, type CreatedCopy } from "../../components/sharing/Copies";
import { PageHeader } from "../../components/ui";
import { useResource } from "../../hooks";
import "../../styles/rooms/sharing.css";

// Sharing › Coaches: the copies shared with a coach and what coaches wrote on them, beside the form
// for a new copy. The page holds the list and the one-time link, so a new copy appears in the list
// at once and revoking the copy whose link is on show takes the link away.

export function SharingCoaches() {
  const grants = useResource(api.shares);
  const [created, setCreated] = useState<CreatedCopy | null>(null);
  return (
    <>
      <PageHeader title="Coaches">
        Share a fixed copy with someone who’s helping you. They can read it and comment on it. Only you can change your
        resume.
      </PageHeader>
      <div className="app-sharing-cols">
        <div className="app-stack">
          <CopyList
            grants={grants}
            onRevoked={(grantId) => setCreated((shown) => (shown?.grant.id === grantId ? null : shown))}
          />
          <OwnerComments />
          <PlaceholderSection name="liveAccess" />
        </div>
        <div className="app-stack">
          <NewCopy
            created={created}
            onCreated={async (next) => {
              setCreated(next);
              await grants.reload();
            }}
          />
        </div>
      </div>
    </>
  );
}
