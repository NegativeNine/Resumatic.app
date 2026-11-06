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
