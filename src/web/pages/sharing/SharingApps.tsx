import { ConnectedApps } from "../../components/ConnectedApps";
import { PageHeader } from "../../components/ui";
import "../../styles/rooms/sharing.css";

// Sharing › Connected apps, reached only where connected apps are switched on: elsewhere its
// address is not found and its tab isn't shown. The list and its revoke are ConnectedApps' own.

export function SharingApps() {
  return (
    <>
      <PageHeader title="Connected apps">
        Let an assistant or a tool you use work with your record. It can do only what you allow, and only for 30 days at a
        time.
      </PageHeader>
      <div className="app-stack app-sharing-apps">
        <ConnectedApps />
      </div>
    </>
  );
}
