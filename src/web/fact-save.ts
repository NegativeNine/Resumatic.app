import type { FactPatch, FactView } from "../shared/api";

/** A fresh snapshot can resolve a lost reply only when it contains this edit at the next revision. */
export function factWriteObserved(current: FactView | undefined, original: FactView, patch: FactPatch): boolean {
  const revision = original.revision;
  if (!Number.isSafeInteger(revision) || revision! < 1 || revision! >= Number.MAX_SAFE_INTEGER || patch.expectedRevision !== revision) return false;
  const text = patch.text ?? original.text;
  const roleId = patch.roleId === undefined ? original.roleId : patch.roleId;
  const level = patch.level !== undefined ? patch.level
    : text !== original.text || original.origin !== "user" ? null : original.level;
  return current?.id === original.id && current.revision === revision! + 1 &&
    current.text === text && current.roleId === roleId && current.level === level &&
    current.kind === original.kind && current.state === original.state && current.origin === "user" &&
    (patch.level === undefined || current.levelNeedsReview !== true);
}
