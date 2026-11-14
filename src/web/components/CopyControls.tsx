import type { CopyLinkView, CopyReviewView } from "../../shared/api";
import { api } from "../api";
import { useAction, type Reload } from "../hooks";
import { ActionError } from "./ui";

/** Owner-only controls. Every underlying row and source quote remains available. */
export function CopyControls({ items, filenames, reload, disabled = false }: {
  items: { id: string; sourceId: string | null; copyReview?: CopyReviewView }[];
  filenames: ReadonlyMap<string, string>;
  reload: Reload;
  disabled?: boolean;
}) {
  const action = useAction();
  const ids = new Set(items.map((item) => item.id));
  const links = new Map<string, CopyLinkView>();
  const separated = new Map<string, CopyLinkView>();
  for (const item of items) {
    for (const link of item.copyReview?.links ?? []) if (ids.has(link.from) && ids.has(link.to)) links.set(link.id, link);
    for (const link of item.copyReview?.separations ?? []) separated.set(link.id, link);
  }
  if (!links.size && !separated.size) return null;
  async function decide(link: CopyLinkView, decision: "confirmed" | "rejected") {
    await action.run(async () => {
      await api.decideIdenticalCopy(link, decision);
      await reload();
    });
  }
  return (
    <div className="app-stack" aria-label="Identical copies">
      {[...links.values()].map((link) => {
        const copy = items.find((item) => item.id === link.from);
        const name = copy?.sourceId ? filenames.get(copy.sourceId) ?? "another file" : "your added copy";
        return <button key={link.id} className="small quiet" disabled={disabled || action.pending} onClick={() => void decide(link, "rejected")}>
          Keep the copy from {name} separate
        </button>;
      })}
      {[...separated.values()].map((link) => <button key={link.id} className="small quiet" disabled={disabled || action.pending} onClick={() => void decide(link, "confirmed")}>
        Show these identical copies together again
      </button>)}
      <ActionError message={action.error} />
    </div>
  );
}

/** The owner asks to group copies; merely opening a page never merges anything. */
export function GroupIdenticalCopies({ enabled, reload }: { enabled: boolean; reload: Reload }) {
  const action = useAction();
  if (!enabled) return null;
  return <div className="app-stack">
    <button className="small quiet" disabled={action.pending} onClick={() => void action.run(async () => {
      await api.groupIdenticalCopies(); await reload();
    })}>{action.pending ? "Grouping copies…" : "Group identical copies"}</button>
    <p className="rs-meta">Same words, same role. Every source quote stays, and you can keep a copy separate.</p>
    <ActionError message={action.error} />
  </div>;
}
