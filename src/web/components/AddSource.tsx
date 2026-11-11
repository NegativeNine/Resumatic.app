import { useState } from "react";
import type { Reload } from "../hooks";
import { PasteText } from "./PasteText";
import { Uploader } from "./Uploader";

/**
 * Adding a source: upload a file, or paste text. Both panels stay mounted, one hidden, so an
 * upload or a paste under way, and what was typed, survive switching between them.
 */
export function AddSource({ onAdded, size = "rail" }: { onAdded: Reload; size?: "rail" | "first-run" }) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  return (
    <div className="app-add-source">
      <div className="rs-filter app-view-toggle" role="group" aria-label="Add a source">
        <button type="button" className="rs-filter__opt" aria-pressed={mode === "file"} onClick={() => setMode("file")}>
          Upload a file
        </button>
        <button type="button" className="rs-filter__opt" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
          Paste text
        </button>
      </div>
      <div hidden={mode !== "file"}>
        <Uploader onUploaded={onAdded} size={size} />
      </div>
      <div hidden={mode !== "paste"}>
        <PasteText onAdded={onAdded} size={size} />
      </div>
    </div>
  );
}
