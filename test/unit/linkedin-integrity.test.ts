import { strToU8, zipSync, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { describe, expect, it } from "vitest";
import { linkedInMarkdown } from "../../src/pipeline/linkedin";

function header(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length; i++)
    if (view.getUint32(i, true) === signature) return i;
  throw new Error("missing ZIP header");
}

function lieAboutSize(bytes: Uint8Array, size: number, local: boolean): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setUint32(header(copy, 0x02014b50) + 24, size, true);
  if (local) view.setUint32(header(copy, 0x04034b50) + 22, size, true);
  return copy;
}

function streamingArchive(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  const file = new ZipDeflate("nested/Skills.csv");
  zip.add(file);
  file.push(strToU8("Name\nGo\n"), false);
  file.push(strToU8("Rust\n"), true);
  const ignored = new ZipPassThrough("Messages.csv");
  zip.add(ignored);
  ignored.push(strToU8("private data stays out of the source"), true);
  zip.end();
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function unsignedDescriptorArchive(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  const file = new ZipDeflate("Skills.csv");
  zip.add(file);
  file.push(strToU8("Name\nGo\n"), true);
  zip.end();
  const original = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { original.set(chunk, offset); offset += chunk.length; }
  const signature = header(original, 0x08074b50);
  const out = new Uint8Array(original.length - 4);
  out.set(original.subarray(0, signature));
  out.set(original.subarray(signature + 4), signature);
  const eocd = header(out, 0x06054b50);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(eocd + 16, view.getUint32(eocd + 16, true) - 4, true);
  return out;
}

// Python zipfile.open(..., force_zip64=True), with ZIP32 central directory.
// These represent stored and deflated files, on seekable and streaming outputs.
const PYTHON_LOCAL_ZIP64 = [
  "UEsDBC0AAAAAAAAAIQAV/nbe//////////8KABQAU2tpbGxzLmNzdgEAEAANAAAAAAAAAA0AAAAAAAAATmFtZQpHbwpSdXN0ClBLAQItAy0AAAAAAAAAIQAV/nbeDQAAAA0AAAAKAAAAAAAAAAAAAACAAQAAAABTa2lsbHMuY3N2UEsFBgAAAAABAAEAOAAAAEkAAAAAAA==",
  "UEsDBC0ACAAAAAAAIQAAAAAA//////////8KABQAU2tpbGxzLmNzdgEAEAAAAAAAAAAAAAAAAAAAAAAATmFtZQpHbwpSdXN0ClBLBwgV/nbeDQAAAAAAAAANAAAAAAAAAFBLAQItAy0ACAAAAAAAIQAV/nbeDQAAAA0AAAAKAAAAAAAAAAAAAACAAQAAAABTa2lsbHMuY3N2UEsFBgAAAAABAAEAOAAAAGEAAAAAAA==",
  "UEsDBC0AAAAIAAAAIQAV/nbe//////////8KABQAU2tpbGxzLmNzdgEAEAANAAAAAAAAAA8AAAAAAAAA80vMTeVyz+cKKi0u4QIAUEsBAi0DLQAAAAgAAAAhABX+dt4PAAAADQAAAAoAAAAAAAAAAAAAAIABAAAAAFNraWxscy5jc3ZQSwUGAAAAAAEAAQA4AAAASwAAAAAA",
  "UEsDBC0ACAAIAAAAIQAAAAAA//////////8KABQAU2tpbGxzLmNzdgEAEAAAAAAAAAAAAAAAAAAAAAAA80vMTeVyz+cKKi0u4QIAUEsHCBX+dt4PAAAAAAAAAA0AAAAAAAAAUEsBAi0DLQAIAAgAAAAhABX+dt4PAAAADQAAAAoAAAAAAAAAAAAAAIABAAAAAFNraWxscy5jc3ZQSwUGAAAAAAEAAQA4AAAAYwAAAAAA",
] as const;
const fixture = (index: number): Uint8Array => Uint8Array.from(Buffer.from(PYTHON_LOCAL_ZIP64[index]!, "base64"));

// Python zipfile with ZIP64_LIMIT=1: ZIP64 central sizes, EOCD and locator.
// Includes stored/deflated members on seekable and non-seekable outputs.
const PYTHON_CENTRAL_ZIP64 = [
  "UEsDBC0AAAAAAAAAIQAV/nbe//////////8KABQAU2tpbGxzLmNzdgEAEAANAAAAAAAAAA0AAAAAAAAATmFtZQpHbwpSdXN0ClBLAQItAy0AAAAAAAAAIQAV/nbe//////////8KABQAAAAAAAAAAACAAQAAAABTa2lsbHMuY3N2AQAQAA0AAAAAAAAADQAAAAAAAABQSwYGLAAAAAAAAAAtAC0AAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAATAAAAAAAAABJAAAAAAAAAFBLBgcAAAAAlQAAAAAAAAABAAAAUEsFBgAAAAABAAEATAAAAEkAAAAAAA==",
  "UEsDBC0ACAAAAAAAIQAAAAAA//////////8KABQAU2tpbGxzLmNzdgEAEAAAAAAAAAAAAAAAAAAAAAAATmFtZQpHbwpSdXN0ClBLBwgV/nbeDQAAAAAAAAANAAAAAAAAAFBLAQItAy0ACAAAAAAAIQAV/nbe//////////8KABQAAAAAAAAAAACAAQAAAABTa2lsbHMuY3N2AQAQAA0AAAAAAAAADQAAAAAAAABQSwYGLAAAAAAAAAAtAC0AAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAATAAAAAAAAABhAAAAAAAAAFBLBgcAAAAArQAAAAAAAAABAAAAUEsFBgAAAAABAAEATAAAAGEAAAAAAA==",
  "UEsDBC0AAAAIAAAAIQAV/nbe//////////8KABQAU2tpbGxzLmNzdgEAEAANAAAAAAAAAA8AAAAAAAAA80vMTeVyz+cKKi0u4QIAUEsBAi0DLQAAAAgAAAAhABX+dt7//////////woAFAAAAAAAAAAAAIABAAAAAFNraWxscy5jc3YBABAADQAAAAAAAAAPAAAAAAAAAFBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAABMAAAAAAAAAEsAAAAAAAAAUEsGBwAAAACXAAAAAAAAAAEAAABQSwUGAAAAAAEAAQBMAAAASwAAAAAA",
  "UEsDBC0ACAAIAAAAIQAAAAAA//////////8KABQAU2tpbGxzLmNzdgEAEAAAAAAAAAAAAAAAAAAAAAAA80vMTeVyz+cKKi0u4QIAUEsHCBX+dt4PAAAAAAAAAA0AAAAAAAAAUEsBAi0DLQAIAAgAAAAhABX+dt7//////////woAFAAAAAAAAAAAAIABAAAAAFNraWxscy5jc3YBABAADQAAAAAAAAAPAAAAAAAAAFBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAABMAAAAAAAAAGMAAAAAAAAAUEsGBwAAAACvAAAAAAAAAAEAAABQSwUGAAAAAAEAAQBMAAAAYwAAAAAA",
] as const;
const centralFixture = (index: number): Uint8Array => Uint8Array.from(Buffer.from(PYTHON_CENTRAL_ZIP64[index]!, "base64"));

/** Add a ZIP64 trailer to an otherwise ordinary ZIP32 archive. */
function zip64Envelope(original: Uint8Array, sentinel: boolean): Uint8Array {
  const end = header(original, 0x06054b50);
  const before = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const out = new Uint8Array(original.length + 76);
  out.set(original.subarray(0, end));
  out.set(original.subarray(end), end + 76);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(end, 0x06064b50, true);
  view.setBigUint64(end + 4, 44n, true);
  view.setUint16(end + 12, 45, true); view.setUint16(end + 14, 45, true);
  view.setBigUint64(end + 24, BigInt(before.getUint16(end + 8, true)), true);
  view.setBigUint64(end + 32, BigInt(before.getUint16(end + 10, true)), true);
  view.setBigUint64(end + 40, BigInt(before.getUint32(end + 12, true)), true);
  view.setBigUint64(end + 48, BigInt(before.getUint32(end + 16, true)), true);
  view.setUint32(end + 56, 0x07064b50, true);
  view.setBigUint64(end + 64, BigInt(end), true);
  view.setUint32(end + 72, 1, true);
  if (sentinel) {
    view.setUint16(end + 76 + 8, 0xffff, true); view.setUint16(end + 76 + 10, 0xffff, true);
    view.setUint32(end + 76 + 12, 0xffffffff, true); view.setUint32(end + 76 + 16, 0xffffffff, true);
  }
  return out;
}

function widenDescriptor(original: Uint8Array): Uint8Array {
  const descriptor = header(original, 0x08074b50);
  const before = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const out = new Uint8Array(original.length + 8);
  out.set(original.subarray(0, descriptor + 8));
  out.set(original.subarray(descriptor + 16), descriptor + 24);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(descriptor + 8, BigInt(before.getUint32(descriptor + 8, true)), true);
  view.setBigUint64(descriptor + 16, BigInt(before.getUint32(descriptor + 12, true)), true);
  const end = header(out, 0x06054b50);
  view.setUint32(end + 16, view.getUint32(end + 16, true) + 8, true);
  let central = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index++) {
    const local = view.getUint32(central + 42, true);
    if (local > descriptor) view.setUint32(central + 42, local + 8, true);
    central += 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  }
  return out;
}

/** Store the member's local-header pointer in the central ZIP64 extra field. */
function zip64LocalOffset(original: Uint8Array, localOffset: bigint): Uint8Array {
  const central = header(original, 0x02014b50);
  const before = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const extra = central + 46 + before.getUint16(central + 28, true);
  const insertion = extra + 4 + before.getUint16(extra + 2, true);
  const out = new Uint8Array(original.length + 8);
  out.set(original.subarray(0, insertion));
  out.set(original.subarray(insertion), insertion + 8);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(insertion, localOffset, true);
  view.setUint16(extra + 2, view.getUint16(extra + 2, true) + 8, true);
  view.setUint16(central + 30, view.getUint16(central + 30, true) + 8, true);
  view.setUint32(central + 42, 0xffffffff, true);
  const end64 = header(out, 0x06064b50);
  view.setBigUint64(end64 + 40, view.getBigUint64(end64 + 40, true) + 8n, true);
  view.setBigUint64(header(out, 0x07064b50) + 8, BigInt(end64), true);
  const end = header(out, 0x06054b50);
  view.setUint32(end + 12, view.getUint32(end + 12, true) + 8, true);
  return out;
}

describe("LinkedIn archive content integrity", () => {
  it.each([false, true])("rejects underreported decoded size, including a falsified local header: %s", (local) => {
    const zip = zipSync({ "Skills.csv": strToU8("Name\nGo\nRust\n") });
    expect(() => linkedInMarkdown(lieAboutSize(zip, 8, local))).toThrow("ZIP export could not be read");
  });

  it("rejects an overexpanded member even when both headers lie about its size", () => {
    const zip = zipSync({ "Skills.csv": strToU8(`Name\n${"a".repeat(6 * 1024 * 1024)}`) });
    expect(() => linkedInMarkdown(lieAboutSize(zip, 8, true))).toThrow("ZIP export could not be read");
  });

  it("rejects a stored member truncated by falsifying both headers", () => {
    const zip = zipSync({ "Skills.csv": strToU8("Name\nGo\nRust\n") }, { level: 0 });
    const copy = lieAboutSize(zip, 8, true);
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    view.setUint32(header(copy, 0x04034b50) + 18, 8, true);
    view.setUint32(header(copy, 0x02014b50) + 20, 8, true);
    expect(() => linkedInMarkdown(copy)).toThrow("ZIP export could not be read");
  });

  it("rejects a stored member whose bytes fail the directory CRC", () => {
    const zip = zipSync({ "Skills.csv": strToU8("Name\nGo\n") }, { level: 0 });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const local = header(zip, 0x04034b50);
    const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    zip[data + 5] ^= 1;
    expect(() => linkedInMarkdown(zip)).toThrow("ZIP export could not be read");
  });

  it("rejects a directory pointer that names a different local member", () => {
    const zip = zipSync({
      "Skills.csv": strToU8("Name\nGo\n"),
      "Messages.csv": strToU8("Name\nNo\n"),
    });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const firstLocal = header(zip, 0x04034b50);
    const next = firstLocal + 30 + view.getUint16(firstLocal + 26, true) +
      view.getUint16(firstLocal + 28, true) + view.getUint32(firstLocal + 18, true);
    expect(view.getUint32(next, true)).toBe(0x04034b50);
    view.setUint32(header(zip, 0x02014b50) + 42, next, true);
    expect(() => linkedInMarkdown(zip)).toThrow("ZIP export could not be read");
  });

  it("accepts a streaming archive with data descriptors and ignores unrelated members", () => {
    const markdown = linkedInMarkdown(streamingArchive());
    expect(markdown).toContain("Name: Go");
    expect(markdown).toContain("Name: Rust");
    expect(markdown).not.toContain("private data");
  });

  it("accepts a streaming ZIP with an unsigned data descriptor", () => {
    expect(linkedInMarkdown(unsignedDescriptorArchive())).toContain("Name: Go");
  });

  it.each(PYTHON_LOCAL_ZIP64.map((_, index) => index))(
    "imports Python's small ZIP64 local-header archive %i",
    (index) => {
      const markdown = linkedInMarkdown(fixture(index));
      expect(markdown).toContain("Name: Go");
      expect(markdown).toContain("Name: Rust");
    },
  );

  it.each(PYTHON_CENTRAL_ZIP64.map((_, index) => index))(
    "imports Python's ZIP64 central-directory archive %i",
    (index) => {
      const markdown = linkedInMarkdown(centralFixture(index));
      expect(markdown).toContain("Name: Go");
      expect(markdown).toContain("Name: Rust");
    },
  );

  it.each([false, true])("accepts ZIP64 trailers with ordinary 32-bit member descriptors (sentinels %s)", (sentinel) => {
    expect(linkedInMarkdown(zip64Envelope(streamingArchive(), sentinel))).toContain("Name: Rust");
  });

  it("accepts an unambiguous 64-bit descriptor for a ZIP32 member in a ZIP64 archive", () => {
    const signed = zip64Envelope(widenDescriptor(streamingArchive()), false);
    expect(linkedInMarkdown(signed)).toContain("Name: Rust");
  });

  it("validates central ZIP64 local-header pointers before reading the archive", () => {
    expect(linkedInMarkdown(zip64LocalOffset(centralFixture(0), 0n))).toContain("Name: Rust");
    for (const offset of [1n, 2n ** 53n]) {
      expect(() => linkedInMarkdown(zip64LocalOffset(centralFixture(0), offset))).toThrow();
    }
  });

  it("rejects unsafe ZIP64 end records, locators and central extra fields", () => {
    for (const mutate of [
      (view: DataView, bytes: Uint8Array) => view.setBigUint64(header(bytes, 0x07064b50) + 8, 2n ** 53n, true),
      (view: DataView, bytes: Uint8Array) => view.setBigUint64(header(bytes, 0x06064b50) + 32, 201n, true),
      (view: DataView, bytes: Uint8Array) => view.setUint32(header(bytes, 0x07064b50) + 16, 2, true),
      (view: DataView, bytes: Uint8Array) => view.setBigUint64(header(bytes, 0x06064b50) + 48, 2n ** 53n, true),
      (view: DataView, bytes: Uint8Array) => view.setUint16(header(bytes, 0x06054b50) + 10, 2, true),
      (view: DataView, bytes: Uint8Array) => view.setUint16(header(bytes, 0x02014b50) + 30, 4, true),
      (view: DataView, bytes: Uint8Array) => view.setUint32(header(bytes, 0x07064b50), 0, true),
    ]) {
      const zip = centralFixture(0);
      mutate(new DataView(zip.buffer, zip.byteOffset, zip.byteLength), zip);
      expect(() => linkedInMarkdown(zip)).toThrow();
    }
  });

  it("accepts an unsigned ZIP64 data descriptor", () => {
    const original = fixture(3);
    const signature = header(original, 0x08074b50);
    const out = new Uint8Array(original.length - 4);
    out.set(original.subarray(0, signature));
    out.set(original.subarray(signature + 4), signature);
    const eocd = header(out, 0x06054b50);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(eocd + 16, view.getUint32(eocd + 16, true) - 4, true);
    expect(linkedInMarkdown(out)).toContain("Name: Rust");
  });

  it("rejects corrupt local ZIP64 sizes and descriptors", () => {
    const corruptLocal = fixture(0);
    const localView = new DataView(corruptLocal.buffer, corruptLocal.byteOffset, corruptLocal.byteLength);
    const localExtra = 30 + localView.getUint16(26, true);
    localView.setBigUint64(localExtra + 4, 0x1_0000_0000n, true);
    expect(() => linkedInMarkdown(corruptLocal)).toThrow("ZIP export could not be read");

    const corruptDescriptor = fixture(3);
    const descriptorView = new DataView(corruptDescriptor.buffer, corruptDescriptor.byteOffset, corruptDescriptor.byteLength);
    descriptorView.setBigUint64(header(corruptDescriptor, 0x08074b50) + 8, 0x1_0000_0000n, true);
    expect(() => linkedInMarkdown(corruptDescriptor)).toThrow("ZIP export could not be read");

    const missingExtra = fixture(0);
    const missingView = new DataView(missingExtra.buffer, missingExtra.byteOffset, missingExtra.byteLength);
    missingView.setUint16(30 + missingView.getUint16(26, true), 2, true);
    expect(() => linkedInMarkdown(missingExtra)).toThrow("ZIP export could not be read");
  });

  it("still rejects duplicate career basenames in streaming archives", () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
    for (const name of ["Skills.csv", "nested/SKILLS.CSV"]) {
      const file = new ZipDeflate(name);
      zip.add(file);
      file.push(strToU8("Name\nGo\n"), true);
    }
    zip.end();
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    expect(() => linkedInMarkdown(bytes)).toThrow("duplicate career files");
  });
});
