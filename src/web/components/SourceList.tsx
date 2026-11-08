import { useRef, useState } from "react";
import type { SourceView } from "../../shared/api";
import { api } from "../api";
import { count, formatDate } from "../format";
import { useAction, type Reload } from "../hooks";
import { sourceReviewSummaries, type Vault } from "../vault";
import { useSession } from "../session";
import { rasterizeResume } from "../scan";
import { ApiError } from "../api";
import { ActionError, Badge, Glyph } from "./ui";
import { sourceErrorMessage } from "../source-error";

export function SourceList({
  vault,
  reload,
}: {
  vault: Vault;
  reload: Reload;
}) {
  const { me } = useSession();
  const sources = [...vault.sources].sort((a, b) => b.createdAt - a.createdAt);
  const summaries = sourceReviewSummaries(vault);
  const revisions = Object.fromEntries(
    [...vault.roles, ...vault.facts].map((item) => [
      item.id,
      item.revision ?? 1,
    ]),
  );

  return (
    <>
      {sources.length === 0 ? (
        <p className="rs-empty">No sources yet. Upload your current resume to get started.</p>
      ) : (
        <ul className="rs-sources rs-panel app-source-panel">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              proposedIds={summaries.get(source.id)?.proposedIds ?? []}
              proposedRoles={summaries.get(source.id)?.proposedRoles ?? 0}
              proposedFacts={summaries.get(source.id)?.proposedFacts ?? 0}
              visibleItems={summaries.get(source.id)?.visibleItems ?? 0}
              revisions={revisions}
              reload={reload}
              ocrEnabled={Boolean(me.capabilities?.ocr)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function SourceRow({
  source,
  proposedIds,
  proposedRoles,
  proposedFacts,
  visibleItems,
  revisions,
  reload,
  ocrEnabled,
}: {
  source: SourceView;
  proposedIds: string[];
  proposedRoles: number;
  proposedFacts: number;
  visibleItems: number;
  revisions: Record<string, number>;
  reload: Reload;
  ocrEnabled: boolean;
}) {
  return (
    <li className="rs-source" tabIndex={-1}>
      <Glyph name="file" />
      <p className="rs-source__name">
        {source.origin === "ocr" ? source.filename.replace(/\.ocr\.json$/i, "") : source.filename}
      </p>
      <p className="rs-source__meta app-meta-row">
        <SourceStatus source={source} proposedRoles={proposedRoles} proposedFacts={proposedFacts} visibleItems={visibleItems} />
      </p>
      <p className="rs-source__meta app-meta-row">
        <span>Uploaded {formatDate(source.createdAt)}</span>
        <a href={api.sourceFileUrl(source.id)}>
          {source.origin === "ocr" ? "Download image inputs (JSON)" : "Download source"}
        </a>
        {source.origin === "ocr" && source.parentSourceId && (
          <a href={api.sourceFileUrl(source.parentSourceId)}>Download original PDF</a>
        )}
      </p>
      {source.origin === "ocr" && (
        <p className="rs-source__meta">
          <Badge tone="queued">Image transcription</Badge> Check proposed facts against the original PDF.
          {source.conversionImageCount != null &&
            ` ${source.conversionImageCount} image${source.conversionImageCount === 1 ? "" : "s"} submitted.`}
        </p>
      )}
      <div className="rs-source__extra app-source-extra">
      {source.state === "queued" && source.cancellationPending && (
        <p className="source-error" role="status">
          Cancellation is pending. Reading may still start or continue; please check back.
        </p>
      )}
      {source.state === "queued" && source.dispatchUncertain && !source.cancellationPending && (
        <p className="source-error" role="status">
          Your upload was saved, but we can't confirm that reading started. It
          may still begin; please check back.
        </p>
      )}
      {source.state === "queued" && !source.cancellationPending && (
        <CancelReading sourceId={source.id} reload={reload} />
      )}
      {source.state === "failed" && (
        <div>
          <p className="source-error">
            {sourceErrorMessage(source.error)}
          </p>
          {source.retryRunId && <RetryReading runId={source.retryRunId} reload={reload} />}
        </div>
      )}
      {source.state === "ready" &&
        Boolean(source.conversionWarnings?.length) && (
          <p className="source-error" role="status">
            Some text may be missing or out of order. Check the source
            carefully; a Word document or text export may read better.
          </p>
        )}
      {source.state === "ready" && visibleItems === 0 && (
        <p className="source-error" role="status">
          No roles or facts from this source are shown. Check the source, try a
          different format, or add your experience manually below.
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
      </div>
    </li>
  );
}

function RetryReading({ runId, reload }: { runId: string; reload: Reload }) {
  const { run, pending, error } = useAction();
  return (
    <div>
      <button type="button" className="small" disabled={pending} onClick={() => void run(async () => {
        await api.retryRun(runId);
        await reload();
      })}>
        {pending ? "Retrying…" : "Retry reading"}
      </button>
      <ActionError message={error} />
    </div>
  );
}

function CancelReading({ sourceId, reload }: { sourceId: string; reload: Reload }) {
  const { run, pending, error } = useAction();
  return (
    <div>
      <button type="button" className="small" disabled={pending} onClick={() => void run(async () => {
        await api.cancelSource(sourceId);
        await reload();
      })}>
        {pending ? "Stopping…" : "Cancel reading"}
      </button>
      <ActionError message={error} />
    </div>
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

function SourceStatus({ source, proposedRoles, proposedFacts, visibleItems }: {
  source: SourceView; proposedRoles: number; proposedFacts: number; visibleItems: number;
}) {
  switch (source.state) {
    case "queued":
      if (source.cancellationPending)
        return <Badge tone="queued">Cancellation pending</Badge>;
      if (source.dispatchUncertain)
        return <Badge tone="queued">Start unconfirmed</Badge>;
      return (
        <Badge tone="queued">
          <span className="spinner" aria-hidden="true" />
          Reading…
        </Badge>
      );
    case "failed":
      return <Badge tone="failed">Reading stopped</Badge>;
    case "ready": {
      const pending = [
        proposedRoles ? count(proposedRoles, "role") : "",
        proposedFacts ? count(proposedFacts, "fact") : "",
      ].filter(Boolean).join(" and ");
      return (
        <>
          <Badge tone="ready">
            <Glyph name="check" />
            Ready
          </Badge>
          <span>{pending ? `${pending} to review` : visibleItems ? "Review complete" : "No items shown"}</span>
        </>
      );
    }
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
