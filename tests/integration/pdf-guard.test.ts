import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDF_LIMITS, PdfRefusedError, readPdfPages, readPdfText, type PdfLimits } from "@/lib/pdf/guard";
import { extractLetterText } from "@/lib/services/letters";
import { pdfLines } from "@/lib/assessments/extract/read";
import { buildPdf } from "../helpers/pdf";

const limits = (over: Partial<PdfLimits> = {}): PdfLimits => ({ ...PDF_LIMITS.letter, ...over });
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PdfRefusedError);
  return e as PdfRefusedError;
};

describe("PDF guard", () => {
  it("reads an ordinary PDF the same way as before (text and positioned items)", async () => {
    const pdf = buildPdf({ pages: 2, text: (p) => `Synthetic letter page ${p}` });
    expect(await readPdfText(pdf, limits())).toBe("Synthetic letter page 1\nSynthetic letter page 2");
    const pages = await readPdfPages(pdf, limits());
    expect(pages).toHaveLength(2);
    expect(pages[0]![0]).toMatchObject({
      str: "Synthetic letter page 1",
      transform: [12, 0, 0, 12, 72, 720],
    });
    // The bundled sample letter still reads.
    const sample = await extractLetterText(
      "x.pdf",
      readFileSync("fixtures/letters/client2_cigna_approval.pdf"),
    );
    expect(sample).toMatch(/approv/i);
  });

  it("refuses a file over the size limit before parsing", async () => {
    const e = await refusal(readPdfText(buildPdf({ pages: 1 }), limits({ maxBytes: 100 })));
    expect(e).toMatchObject({ status: 413, code: "too_large" });
  });

  it("refuses too many pages", async () => {
    const e = await refusal(readPdfText(buildPdf({ pages: 41 }), PDF_LIMITS.assessment));
    expect(e).toMatchObject({ status: 422, code: "too_many_pages" });
    expect(e.message).toBe("This PDF has more than 40 pages. Upload only the pages you need.");
  });

  it("refuses too much extracted text", async () => {
    const line = (p: number) => `Synthetic page ${p} of a longer letter`;
    const pdf = buildPdf({ pages: 3, text: line });
    expect(await readPdfText(pdf, limits({ maxTextChars: 200 }))).toHaveLength(3 * line(1).length + 2);
    const e = await refusal(readPdfText(pdf, limits({ maxTextChars: 100 })));
    expect(e.code).toBe("too_much_text");
  });

  it("refuses a decompression bomb (a few kilobytes that unpack to hundreds of megabytes)", async () => {
    const bomb = buildPdf({ pages: 1, bombBytes: 200 * 1024 * 1024 });
    expect(bomb.length).toBeLessThan(400 * 1024);
    const e = await refusal(readPdfText(bomb, PDF_LIMITS.letter));
    expect(e).toMatchObject({ status: 413, code: "too_large_unpacked" });
    // Compressed twice over: the inner layer is checked too.
    const chained = buildPdf({ pages: 1, bombBytes: 200 * 1024 * 1024, chained: true });
    expect(chained.length).toBeLessThan(20 * 1024);
    expect((await refusal(readPdfText(chained, PDF_LIMITS.letter))).code).toBe("too_large_unpacked");
    // Under the limit it is fine.
    expect(await readPdfText(buildPdf({ pages: 1, bombBytes: 1024 * 1024 }), PDF_LIMITS.letter)).toBe(
      "Synthetic page 1",
    );
  });

  it("stops a read that takes too long", async () => {
    const e = await refusal(readPdfText(buildPdf({ pages: 5 }), limits({ timeoutMs: 1 })));
    expect(e).toMatchObject({ status: 422, code: "timeout" });
    expect(e.message).toMatch(/took too long/);
  });

  it("a PDF that needs more memory than the worker's heap limit stops the worker, not the server", async () => {
    const e = await refusal(readPdfText(buildPdf({ pages: 3 }), limits({ maxHeapMb: 8 })));
    expect(e).toMatchObject({ status: 422, code: "out_of_memory" });
    await expect(readPdfText(buildPdf({ pages: 1 }), limits())).resolves.toBe("Synthetic page 1");
  });

  it("refuses garbage and keeps working afterwards", async () => {
    const e = await refusal(readPdfText(Buffer.from("%PDF-1.4\nnot really a pdf"), limits()));
    expect(e).toMatchObject({ status: 400, code: "unreadable" });
    await expect(readPdfText(buildPdf({ pages: 1 }), limits())).resolves.toBe("Synthetic page 1");
  });

  it("every upload path uses it: letters, assessment score files, payor documents", async () => {
    await expect(extractLetterText("letter.pdf", buildPdf({ pages: 31 }))).rejects.toMatchObject({
      code: "too_many_pages",
    });
    await expect(pdfLines(buildPdf({ pages: 1, bombBytes: 200 * 1024 * 1024 }))).rejects.toMatchObject({
      code: "too_large_unpacked",
    });
    const { extractDocumentText } = await import("@/lib/rules-watch/fetch");
    await expect(
      extractDocumentText(buildPdf({ pages: 1, bombBytes: 400 * 1024 * 1024 }), "application/pdf", "x.pdf"),
    ).rejects.toMatchObject({ code: "too_large_unpacked" });
  });
});
