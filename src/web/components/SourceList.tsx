import { useRef, useState } from "react";
import type { SourceView } from "../../shared/api";
import { api } from "../api";
import { count, formatDate } from "../format";
import { useAction, type Reload } from "../hooks";
import { proposedFrom, type Vault } from "../vault";
import { ActionError, Badge } from "./ui";

export function SourceList({ vault, reload }: { vault: Vault; reload: Reload }) {
  const sources = [...vault.sources].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <section className="section" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Your sources</h2>
      {sources.length === 0 ? (
        <p className="empty">No sources yet. Upload your current resume above to get started.</p>
      ) : (
        <ul className="plain-list source-list">
          {sources.map((source) => (
            <SourceRow key={source.id} source={source} proposedIds={proposedFrom(vault, source.id)} reload={reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SourceRow({ source, proposedIds, reload }: { source: SourceView; proposedIds: string[]; reload: Reload }) {
  return (
    <li className="source" tabIndex={-1}>
      <div className="row-between">
        <div>
          <p className="source-name">{source.filename}</p>
          <p className="meta">
            Uploaded {formatDate(source.createdAt)} · <a href={api.sourceFileUrl(source.id)}>Download original</a>
          </p>
        </div>
        <SourceStatus source={source} />
      </div>
      {source.state === "failed" && (
        <p className="source-error">
          {source.error ?? "We couldn't read this file."} Try uploading it again, or save it in the other format
          (PDF or .docx) and upload that.
        </p>
      )}
      {proposedIds.length > 0 && <ConfirmAll filename={source.filename} ids={proposedIds} reload={reload} />}
    </li>
  );
}

function SourceStatus({ source }: { source: SourceView }) {
  switch (source.state) {
    case "queued":
      return (
        <Badge tone="queued">
          <span className="spinner" aria-hidden="true" />
          Reading…
        </Badge>
      );
    case "failed":
      return <Badge tone="failed">Couldn't read</Badge>;
    case "ready":
      return (
        <Badge tone="ready">
          {source.proposed > 0 ? `Ready · ${count(source.proposed, "fact")} to review` : "Ready · all reviewed"}
        </Badge>
      );
  }
}

function ConfirmAll({ filename, ids, reload }: { filename: string; ids: string[]; reload: Reload }) {
  const [asking, setAsking] = useState(false);
  const { run, pending, error } = useAction();
  const trigger = useRef<HTMLButtonElement>(null);
  const items = count(ids.length, "proposed role and fact", "proposed roles and facts");

  function cancel() {
    setAsking(false);
    trigger.current?.focus();
  }

  async function confirmAll() {
    const row = trigger.current?.closest("li");
    const ok = await run(async () => {
      await api.review({ confirm: ids, reject: [] });
      await reload();
    });
    if (ok) row?.focus();
  }

  return (
    <div className="confirm-all">
      <button ref={trigger} type="button" className="small" aria-expanded={asking} onClick={() => setAsking(!asking)}>
        Confirm all from this source
      </button>
      {asking && (
        <div className="confirm-panel">
          <p>
            Confirm all {items} from {filename}? Only do this if you have checked that every one is true.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary small"
              autoFocus
              disabled={pending}
              onClick={() => void confirmAll()}
            >
              {pending ? "Confirming…" : `Yes, confirm ${ids.length}`}
            </button>
            <button type="button" className="small" onClick={cancel} disabled={pending}>
              Cancel
            </button>
          </div>
          <ActionError message={error} />
        </div>
      )}
    </div>
  );
}
