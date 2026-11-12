import { useRef, useState, type DragEvent } from "react";
import { MAX_UPLOAD_BYTES } from "../../shared/api";
import { api } from "../api";
import { formatBytes } from "../format";
import { useAction, type Reload } from "../hooks";
import { isTransientReadError } from "../polling";
import { ActionError, Glyph, Loading } from "./ui";

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ACCEPT = `.pdf,.docx,.zip,application/pdf,${DOCX_TYPE},application/zip`;
const LIMIT = formatBytes(MAX_UPLOAD_BYTES);

function problemWith(file: File): string | null {
  const name = file.name.toLowerCase();
  const supported =
    name.endsWith(".pdf") || name.endsWith(".docx") || name.endsWith(".zip");
  if (!supported)
    return `“${file.name}” isn’t a PDF, Word (.docx) or LinkedIn data export (.zip). Choose one of those formats.`;
  if (file.size > MAX_UPLOAD_BYTES)
    return `“${file.name}” is ${formatBytes(file.size)}. Files can be up to ${LIMIT}.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  return null;
}

/**
 * The upload panel. Its notice, the sentence for the file it last added, is kept by the page (see
 * `AddSourceState`), because adding the first source replaces the first-run panel with the rail's.
 */
export function Uploader({
  onUploaded,
  size = "rail",
  notice,
  onNotice,
}: {
  onUploaded: Reload;
  size?: "rail" | "first-run";
  notice: string | null;
  onNotice: (sentence: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { run, pending, error, setError } = useAction();
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [retry, setRetry] = useState<{ file: File; key: string } | null>(null);

  async function upload(file: File, key: string = crypto.randomUUID()) {
    setRetry(null);
    onNotice(null);
    const problem = problemWith(file);
    if (problem) {
      setError(problem);
      return;
    }
    setUploading(file.name);
    // Retry upload resends with the same key, for when it isn't clear whether the file arrived.
    // A refusal, such as a second copy of a file, would only be refused again.
    let retryable = true;
    const ok = await run(
      async () => {
        try {
          await api.uploadSource(file, key);
        } catch (e) {
          retryable = isTransientReadError(e);
          throw e;
        }
        await onUploaded();
      },
      {
        too_large: `“${file.name}” is too large. Files can be up to ${LIMIT}.`,
      },
    );
    setUploading(null);
    if (ok) onNotice(`Uploaded ${file.name}. Resumatic is reading it now, and its roles and facts will appear for you to review.`);
    else if (retryable) setRetry({ file, key });
  }

  function drop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && !pending) void upload(file);
  }

  return (
    <div>
      <div
        className={["rs-drop", `app-drop--${size}`, dragging ? "is-dragging" : ""].filter(Boolean).join(" ")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={drop}
      >
        <Glyph name="upload" />
        <p className="rs-drop__title">{size === "first-run" ? "Drop your resume or CV here" : "Drop a resume or CV"}</p>
        <p className="rs-meta">
          PDF, Word (.docx) or LinkedIn data export (.zip), up to {LIMIT}, one file at a time
        </p>
        <button
          type="button"
          className={size === "first-run" ? "rs-btn rs-btn--primary rs-btn--lg" : "rs-btn rs-btn--primary rs-btn--sm"}
          onClick={() => input.current?.click()}
          disabled={pending}
        >
          {pending ? "Uploading…" : "Choose a file"}
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
      {uploading && <Loading>Uploading {uploading}…</Loading>}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      <ActionError message={error} />
      {retry && (
        <button
          type="button"
          className="small"
          disabled={pending}
          onClick={() => void upload(retry.file, retry.key)}
        >
          Retry upload
        </button>
      )}
    </div>
  );
}
