import { ApiError } from "./api";

/** Rasterization is local; page images leave the browser only after the explicit action. */
export async function rasterizeResume(
  blob: Blob,
): Promise<{ mimeType: "image/jpeg"; base64: string }[]> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
  });
  try {
    const document = await task.promise;
    if (document.numPages > 4)
      throw new ApiError(
        422,
        "invalid",
        "Image reading supports the complete PDF up to four pages. Upload a shorter document or a DOCX; no pages have been sent.",
      );
    const images: { mimeType: "image/jpeg"; base64: string }[] = [];
    let totalBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(2, 1600 / Math.max(original.width, original.height)),
      });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!;
        const size =
          (base64.length * 3) / 4 -
          (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
        totalBytes += size;
        if (size > 4 * 1024 * 1024 || totalBytes > 8 * 1024 * 1024)
          throw new ApiError(
            413,
            "too_large",
            "These page images are too large. Please upload a DOCX or a smaller PDF.",
          );
        images.push({ mimeType: "image/jpeg", base64 });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
    return images;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      "invalid",
      "This PDF could not be opened for image reading. Try an unlocked PDF or a Word document.",
    );
  } finally {
    await task.destroy();
  }
}
