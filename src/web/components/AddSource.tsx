import type { Dispatch, SetStateAction } from "react";
import type { Reload } from "../hooks";
import { PasteText, type PasteDraft } from "./PasteText";
import { Uploader } from "./Uploader";

type AddMode = "file" | "paste";

/**
 * What the person chose, is pasting and was last told while adding a source. The Facts page keeps
 * it rather than this component: adding the first source swaps the first-run layout for the rail,
 * and with it this component, so the panel chosen, a paste being written and the sentence saying
 * a source was added must outlive the swap.
 */
export interface AddSourceState {
  mode: AddMode;
  draft: PasteDraft;
  /** The sentence for the source each panel last added, until that panel starts again. */
  notices: Record<AddMode, string | null>;
}

export const ADD_SOURCE_START: AddSourceState = {
  mode: "file",
  draft: { text: "", title: "" },
  notices: { file: null, paste: null },
};

/**
 * Adding a source: upload a file, or paste text. Both panels stay mounted, one hidden, so an
 * upload or a paste under way, and what was typed, survive switching between them.
 */
export function AddSource({
  onAdded,
  size = "rail",
  state,
  onState,
}: {
  onAdded: Reload;
  size?: "rail" | "first-run";
  state: AddSourceState;
  onState: Dispatch<SetStateAction<AddSourceState>>;
}) {
  const { mode } = state;
  const notice = (from: AddMode) => (sentence: string | null) =>
    onState((s) => ({ ...s, notices: { ...s.notices, [from]: sentence } }));
  return (
    <div className="app-add-source">
      <div className="rs-filter app-view-toggle" role="group" aria-label="Add a source">
        <button type="button" className="rs-filter__opt" aria-pressed={mode === "file"} onClick={() => onState((s) => ({ ...s, mode: "file" }))}>
          Upload a file
        </button>
        <button type="button" className="rs-filter__opt" aria-pressed={mode === "paste"} onClick={() => onState((s) => ({ ...s, mode: "paste" }))}>
          Paste text
        </button>
      </div>
      <div hidden={mode !== "file"}>
        <Uploader onUploaded={onAdded} size={size} notice={state.notices.file} onNotice={notice("file")} />
      </div>
      <div hidden={mode !== "paste"}>
        <PasteText
          onAdded={onAdded}
          size={size}
          draft={state.draft}
          onDraft={(draft) => onState((s) => ({ ...s, draft: { ...s.draft, ...draft } }))}
          notice={state.notices.paste}
          onNotice={notice("paste")}
        />
      </div>
    </div>
  );
}
