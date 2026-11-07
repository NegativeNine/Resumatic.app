import type { RolePatch, RoleView } from "../shared/api";

/** A fresh read can resolve a lost reply only at the next revision with the submitted values. */
export function roleWriteObserved(current: RoleView | undefined, original: RoleView, patch: RolePatch): boolean {
  const revision = original.revision;
  if (!Number.isSafeInteger(revision) || revision! < 1 || revision! >= Number.MAX_SAFE_INTEGER || patch.expectedRevision !== revision) return false;
  return current?.id === original.id && current.revision === revision! + 1 &&
    current.kind === (patch.kind ?? original.kind) && current.org === (patch.org ?? original.org) &&
    current.title === (patch.title === undefined ? original.title : patch.title) &&
    current.startDate === (patch.startDate === undefined ? original.startDate : patch.startDate) &&
    current.endDate === (patch.endDate === undefined ? original.endDate : patch.endDate) &&
    (current.unknownEndStartDate ?? null) === (patch.unknownEndStartDate === undefined ? original.unknownEndStartDate ?? null : patch.unknownEndStartDate) &&
    current.state === original.state && current.sourceId === original.sourceId && current.quote === original.quote;
}
