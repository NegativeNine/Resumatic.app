/**
 * Keep retry keys for uncertain create requests across reloads in this tab.
 * Storage contains a digest of the request and a random key, not request text.
 */
export class GenerationKeys {
  private readonly memory = new Map<string, string>();
  private readonly retired = new Set<string>();

  async acquire(path: string, body: unknown): Promise<{ fingerprint: string; key: string }> {
    const bytes = new TextEncoder().encode(JSON.stringify([path, body]));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const storageKey = `resumatic:generation:${fingerprint}`;
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(storageKey); } catch { /* Use the in-memory key. */ }
    const valid = stored && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored) ? stored : null;
    const key = this.memory.get(fingerprint) ?? (this.retired.has(fingerprint) ? null : valid) ?? crypto.randomUUID();
    this.memory.set(fingerprint, key);
    try {
      sessionStorage.setItem(storageKey, key);
      this.retired.delete(fingerprint);
    } catch { /* Retry within this page remains possible. */ }
    return { fingerprint, key };
  }

  acknowledge(fingerprint: string, key: string): void {
    if (this.memory.get(fingerprint) !== key) return;
    this.memory.delete(fingerprint);
    try {
      const storageKey = `resumatic:generation:${fingerprint}`;
      if (sessionStorage.getItem(storageKey) === key) sessionStorage.removeItem(storageKey);
    } catch {
      // Do not reuse an acknowledged key in this page if storage is still
      // readable but refuses removal. A later successful write replaces it.
      this.retired.add(fingerprint);
    }
  }
}
