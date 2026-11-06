/** A single immutable snapshot member. `open` is called only when the member is read. */
export interface ArchiveEntry {
  name: string;
  size: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
}

export interface ArchiveOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  maxEntries?: number;
}

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 1000;

const encoder = new TextEncoder();
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(crc: number, data: Uint8Array): number {
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return crc >>> 0;
}

function header(length: number, fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(length);
  fill(new DataView(bytes.buffer));
  return bytes;
}

function safeName(name: string): Uint8Array {
  // Never allow a ZIP member to escape the extraction directory or alias another path.
  if (!name || name.startsWith("/") || name.includes("\\") || /[\x00-\x1f\x7f]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":")))
    throw new Error("unsafe archive member name");
  const bytes = encoder.encode(name);
  if (bytes.length > 1024) throw new Error("archive member name is too long");
  return bytes;
}

/**
 * Produce a ZIP32 archive using uncompressed members. Each source is read only
 * as the consumer pulls; no archive contents are buffered between members.
 * Member sizes are checked again while reading. Failures truncate/error the
 * stream rather than emitting an apparently complete partial archive.
 */
export function createArchive(entries: ArchiveEntry[], options: ArchiveOptions = {}): ReadableStream<Uint8Array> {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ARCHIVE_BYTES ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_ARCHIVE_ENTRIES || entries.length > maxEntries)
    throw new Error("archive limit exceeded");
  const names = new Set<string>();
  let total = 0;
  const files = entries.map((entry) => {
    const name = safeName(entry.name);
    // TextEncoder replaces unpaired surrogates; compare encoded names so two
    // distinct JS strings cannot silently become the same ZIP member.
    const encoded = Array.from(name).join(",");
    if (names.has(encoded)) throw new Error("duplicate archive member");
    names.add(encoded);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxBytes - total)
      throw new Error("archive limit exceeded");
    total += entry.size;
    return { ...entry, encodedName: name };
  });

  let active: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const abort = () => { void active?.cancel("archive aborted").catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const checkAbort = () => {
    if (cancelled || options.signal?.aborted) throw new DOMException("archive aborted", "AbortError");
  };
  const cleanup = () => options.signal?.removeEventListener("abort", abort);

  async function* generate(): AsyncGenerator<Uint8Array> {
    let offset = 0;
    const central: Uint8Array[] = [];
    try {
      for (const file of files) {
        checkAbort();
        const localOffset = offset;
        // UTF-8 names and a data descriptor (CRC is computed as bytes arrive).
        const local = header(30, (v) => {
          v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true);
          v.setUint16(6, 0x0808, true); v.setUint16(8, 0, true);
          v.setUint16(12, 0x21, true); v.setUint16(26, file.encodedName.length, true);
        });
        offset += local.length + file.encodedName.length;
        yield local;
        yield file.encodedName;
        checkAbort();
        const source = await file.open();
        active = source.getReader();
        let size = 0, crc = 0xffffffff;
        try {
          for (;;) {
            checkAbort();
            const result = await active.read();
            checkAbort();
            if (result.done) break;
            const data = result.value;
            if (!(data instanceof Uint8Array) || data.byteLength > file.size - size)
              throw new Error("archive member size changed");
            if (!data.byteLength) continue;
            size += data.byteLength;
            crc = crc32(crc, data);
            offset += data.byteLength;
            yield data;
          }
          if (size !== file.size) throw new Error("archive member size changed");
        } finally {
          await active.cancel().catch(() => {});
          active.releaseLock();
          active = undefined;
        }
        checkAbort();
        crc = (crc ^ 0xffffffff) >>> 0;
        const descriptor = header(16, (v) => {
          v.setUint32(0, 0x08074b50, true); v.setUint32(4, crc, true);
          v.setUint32(8, size, true); v.setUint32(12, size, true);
        });
        offset += descriptor.length;
        yield descriptor;
        const directory = header(46, (v) => {
          v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true);
          v.setUint16(8, 0x0808, true); v.setUint16(10, 0, true); v.setUint16(14, 0x21, true);
          v.setUint32(16, crc, true); v.setUint32(20, size, true); v.setUint32(24, size, true);
          v.setUint16(28, file.encodedName.length, true); v.setUint32(42, localOffset, true);
        });
        central.push(directory, file.encodedName);
      }
      const centralOffset = offset;
      for (const part of central) { checkAbort(); offset += part.length; yield part; }
      checkAbort();
      yield header(22, (v) => {
        v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true); v.setUint16(10, files.length, true);
        v.setUint32(12, offset - centralOffset, true); v.setUint32(16, centralOffset, true);
      });
    } finally { cleanup(); }
  }
  const iterator = generate();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close(); else controller.enqueue(result.value);
      } catch (error) { cleanup(); controller.error(error); }
    },
    cancel() {
      cancelled = true;
      abort();
      // A backend open may itself be in flight. Do not hold client cancellation
      // waiting for it; once it returns, generate() cancels the source.
      void iterator.return(undefined).catch(() => {});
      cleanup();
    },
  }, { highWaterMark: 0 });
}
