/** Remember only an acknowledged document ID, scoped to this user, application and tab. */
function storageKey(userId: string, applicationId: string): string {
  return `resumatic:document-start:${JSON.stringify([userId, applicationId])}`;
}

export function readDocumentStart(userId: string, applicationId: string): string | null {
  try {
    const id = sessionStorage.getItem(storageKey(userId, applicationId));
    return id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
  } catch {
    // The in-memory guard still applies when the browser denies storage.
    return null;
  }
}

export function rememberDocumentStart(userId: string, applicationId: string, id: string): void {
  try {
    sessionStorage.setItem(storageKey(userId, applicationId), id);
  } catch {
    // Do not make a completed request appear to have failed because storage is unavailable.
  }
}

export function forgetDocumentStart(userId: string, applicationId: string, id: string): void {
  try {
    const key = storageKey(userId, applicationId);
    if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
  } catch {
    // The component also clears its in-memory guard.
  }
}
