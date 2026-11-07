import { useRef, useState, type DragEvent } from "react";
import { MAX_UPLOAD_BYTES } from "../../shared/api";
import { api } from "../api";
import { formatBytes } from "../format";
import { useAction, type Reload } from "../hooks";
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
    return `"${file.name}" isn't a PDF, Word (.docx), or LinkedIn data export (.zip). Choose one of those formats.`;
  if (file.size > MAX_UPLOAD_BYTES)
    return `"${file.name}" is ${formatBytes(file.size)}. Files can be up to ${LIMIT}.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  return null;
}

export function Uploader({ onUploaded, size = "rail" }: { onUploaded: Reload; size?: "rail" | "first-run" }) {
  const input = useRef<HTMLInputElement>(null);
  const { run, pending, error, setError } = useAction();
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [retry, setRetry] = useState<{ file: File; key: string } | null>(null);

  async function upload(file: File, key: string = crypto.randomUUID()) {
    setRetry(null);
    setUploaded(null);
    const problem = problemWith(file);
    if (problem) {
      setError(problem);
      return;
    }
    setUploading(file.name);
    const ok = await run(
      async () => {
        await api.uploadSource(file, key);
        await onUploaded();
      },
      {
        too_large: `"${file.name}" is too large. Files can be up to ${LIMIT}.`,
      },
    );
    setUploading(null);
    if (ok) setUploaded(file.name);
    else setRetry({ file, key });
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
          PDF, Word (.docx), or LinkedIn data export (.zip), up to {LIMIT}, one file at a time
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
      {uploaded && (
        <p className="success" role="status">
          Uploaded {uploaded}. Resumatic is reading it now, and its roles and facts will appear for you to review.
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
