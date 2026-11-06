import { useRef, useState } from "react";
import type { SourceView } from "../../shared/api";
import { api } from "../api";
import { count, formatDate } from "../format";
import { useAction, type Reload } from "../hooks";
import { proposedFrom, type Vault } from "../vault";
import { useSession } from "../session";
import { rasterizeResume } from "../scan";
import { ApiError } from "../api";
import { ActionError, Badge } from "./ui";

export function SourceList({
  vault,
  reload,
}: {
  vault: Vault;
  reload: Reload;
}) {
  const { me } = useSession();
  const sources = [...vault.sources].sort((a, b) => b.createdAt - a.createdAt);
  const revisions = Object.fromEntries(
    [...vault.roles, ...vault.facts].map((item) => [
      item.id,
      item.revision ?? 1,
    ]),
  );

  return (
    <section className="section" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Your sources</h2>
      {sources.length === 0 ? (
        <p className="empty">
          No sources yet. Upload your current resume above to get started.
        </p>
      ) : (
        <ul className="plain-list source-list">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              proposedIds={proposedFrom(vault, source.id)}
              revisions={revisions}
              reload={reload}
              ocrEnabled={Boolean(me.capabilities?.ocr)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SourceRow({
  source,
  proposedIds,
  revisions,
  reload,
  ocrEnabled,
}: {
  source: SourceView;
  proposedIds: string[];
  revisions: Record<string, number>;
  reload: Reload;
  ocrEnabled: boolean;
}) {
  return (
    <li className="source" tabIndex={-1}>
      <div className="row-between">
        <div>
          <p className="source-name">
            {source.origin === "ocr"
              ? source.filename.replace(/\.ocr\.json$/i, "")
              : source.filename}
          </p>
          <p className="meta">
            Uploaded {formatDate(source.createdAt)} ·{" "}
            <a href={api.sourceFileUrl(source.id)}>Download source</a>
          </p>
          {source.origin === "ocr" && (
            <p className="meta">
              <Badge tone="queued">Image transcription</Badge> · Check proposed
              facts against the original PDF.
              {source.conversionImageCount != null &&
                ` ${source.conversionImageCount} image${source.conversionImageCount === 1 ? "" : "s"} submitted.`}
            </p>
          )}
        </div>
        <SourceStatus source={source} />
      </div>
      {source.state === "failed" && (
        <p className="source-error">
          {source.error ?? "We couldn't read this file."} Try uploading it
          again, or save it in the other format (PDF or .docx) and upload that.
        </p>
      )}
      {source.state === "ready" &&
        Boolean(source.conversionWarnings?.length) && (
          <p className="source-error" role="status">
            Some text may be missing or out of order. Check the source
            carefully; a Word document or text export may read better.
          </p>
        )}
      {proposedIds.length > 0 && (
        <ConfirmAll
          filename={source.filename}
          ids={proposedIds}
          revisions={revisions}
          reload={reload}
        />
      )}
      {ocrEnabled &&
        source.state !== "queued" &&
        /\.pdf$/i.test(source.filename) && (
          <ScanRecovery sourceId={source.id} reload={reload} />
        )}
    </li>
  );
}

function ScanRecovery({
  sourceId,
  reload,
}: {
  sourceId: string;
  reload: Reload;
}) {
  const { run, pending, error } = useAction();
  const [progress, setProgress] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  async function recover() {
    setAdded(false);
    const ok = await run(async () => {
      setProgress("Opening your PDF…");
      const response = await fetch(api.sourceFileUrl(sourceId), {
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new ApiError(
          response.status,
          "unavailable",
          "The source file could not be opened. Please try again.",
        );
      setProgress("Preparing all pages as images…");
      const images = await rasterizeResume(await response.blob());
      setProgress("Sending pages for transcription…");
      await api.readSourceImages(sourceId, { images });
      await reload();
    });
    setProgress(null);
    if (ok) setAdded(true);
  }
  return (
    <details className="scan-recovery">
      <summary>Missing text or mixed-up columns?</summary>
      <p className="hint">
        A Word document or a PDF with selectable text usually reads best. You
        can also read the complete PDF as images, up to four pages. This creates
        another source. Check its proposed facts against your original PDF
        because image transcription can misread words and numbers.
      </p>
      <button
        type="button"
        className="small"
        disabled={pending || added}
        onClick={() => void recover()}
      >
        {pending
          ? "Reading images…"
          : added
            ? "Image reading started"
            : "Read this PDF as images"}
      </button>
      {progress && (
        <p className="meta" role="status">
          {progress}
        </p>
      )}
      {added && (
        <p className="success" role="status">
          The new image transcription will appear in your sources for review.
        </p>
      )}
      <ActionError message={error} />
    </details>
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
          {source.proposed > 0
            ? `Ready · ${count(source.proposed, "fact")} to review`
            : "Ready · all reviewed"}
        </Badge>
      );
  }
}

function ConfirmAll({
  filename,
  ids,
  revisions,
  reload,
}: {
  filename: string;
  ids: string[];
  revisions: Record<string, number>;
  reload: Reload;
}) {
  const [asking, setAsking] = useState(false);
  const { run, pending, error } = useAction();
  const trigger = useRef<HTMLButtonElement>(null);
  const items = count(
    ids.length,
    "proposed role and fact",
    "proposed roles and facts",
  );

  function cancel() {
    setAsking(false);
    trigger.current?.focus();
  }

  async function confirmAll() {
    const row = trigger.current?.closest("li");
    const ok = await run(async () => {
      await api.review({
        confirm: ids,
        reject: [],
        expectedRevisions: Object.fromEntries(
          ids.map((id) => [id, revisions[id]!]),
        ),
      });
      await reload();
    });
    if (ok) row?.focus();
  }

  return (
    <div className="confirm-all">
      <button
        ref={trigger}
        type="button"
        className="small"
        aria-expanded={asking}
        onClick={() => setAsking(!asking)}
      >
        Confirm all from this source
      </button>
      {asking && (
        <div className="confirm-panel">
          <p>
            Confirm all {items} from {filename}? Only do this if you have
            checked that every one is true.
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
            <button
              type="button"
              className="small"
              onClick={cancel}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
          <ActionError message={error} />
        </div>
      )}
    </div>
  );
}
