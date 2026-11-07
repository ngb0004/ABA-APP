/**
 * Reading untrusted PDFs safely (assessment score files, payor letters, payor documents). Like the
 * zip-bomb guard for .xlsx/.docx, every PDF is refused with a plain message when it is too big:
 * file size, page count, extracted text, total unpacked (decompressed) size, and reading time.
 * PDF.js runs in a worker thread with a heap limit, so a hostile file can exhaust only that
 * worker, which is then stopped; the server keeps running.
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import { HttpError } from "../log";

export type PdfLimits = {
  maxBytes: number;
  maxPages: number;
  maxTextChars: number;
  /** Total output of every compressed stream, unpacked (checked before PDF.js reads anything). */
  maxInflatedBytes: number;
  maxStreams: number;
  timeoutMs: number;
  /** Worker heap (V8 old generation) in MB. */
  maxHeapMb: number;
};

const MB = 1024 * 1024;

/** Limits per kind of upload. Letters and score files are short; payor policy documents can be long. */
export const PDF_LIMITS = {
  letter: {
    maxBytes: 5 * MB,
    maxPages: 30,
    maxTextChars: 300_000,
    maxInflatedBytes: 60 * MB,
    maxStreams: 5_000,
    timeoutMs: 20_000,
    maxHeapMb: 256,
  },
  assessment: {
    maxBytes: 15 * MB,
    maxPages: 40,
    maxTextChars: 400_000,
    maxInflatedBytes: 100 * MB,
    maxStreams: 10_000,
    timeoutMs: 30_000,
    maxHeapMb: 256,
  },
  payorDocument: {
    maxBytes: 25 * MB,
    maxPages: 600,
    maxTextChars: 4_000_000,
    maxInflatedBytes: 300 * MB,
    maxStreams: 50_000,
    timeoutMs: 60_000,
    maxHeapMb: 512,
  },
} satisfies Record<string, PdfLimits>;

export type PdfRefusal =
  | "too_large"
  | "too_many_pages"
  | "too_much_text"
  | "too_large_unpacked"
  | "timeout"
  | "out_of_memory"
  | "unreadable";

/** A PDF refused by the guard. The message is plain and safe to show; it never quotes the file. */
export class PdfRefusedError extends HttpError {
  constructor(
    public code: PdfRefusal,
    limits: PdfLimits,
  ) {
    super(
      code === "unreadable" ? 400 : code === "too_large" || code === "too_large_unpacked" ? 413 : 422,
      refusalMessage(code, limits),
    );
    this.name = "PdfRefusedError";
  }
}

function refusalMessage(code: PdfRefusal, l: PdfLimits): string {
  switch (code) {
    case "too_large":
      return `This PDF is too large (${Math.round(l.maxBytes / MB)} MB max).`;
    case "too_many_pages":
      return `This PDF has more than ${l.maxPages} pages. Upload only the pages you need.`;
    case "too_much_text":
      return "This PDF holds more text than can be read here. Upload only the pages you need.";
    case "too_large_unpacked":
      return "This PDF is too large once unpacked. Save a smaller copy with only the pages you need.";
    case "timeout":
      return "Reading this PDF took too long. Save a simpler copy (for example, print it to a new PDF) and try again.";
    case "out_of_memory":
      return "This PDF is too complex to read here. Save a simpler copy (for example, print it to a new PDF) and try again.";
    case "unreadable":
      return "This PDF could not be read";
  }
}

export type PdfTextItem = { str: string; transform: number[]; width?: number; height?: number };

/** Two PDFs at a time at most; more wait their turn, so uploads cannot pile up workers. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const workerFile = () => path.join(process.cwd(), "src", "lib", "pdf", "pdf-worker.mjs");

type WorkerReply =
  | { ok: true; text?: string; pages?: PdfTextItem[][] }
  | { ok: false; code: Exclude<PdfRefusal, "too_large" | "timeout" | "out_of_memory"> };

function runWorker(data: Buffer, mode: "text" | "items", limits: PdfLimits): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    // A private copy, handed over (not shared) to the worker.
    const copy = new Uint8Array(data);
    const worker = new Worker(workerFile(), {
      workerData: { data: copy, mode, limits },
      transferList: [copy.buffer],
      // Below a few MB V8 cannot even start the worker and takes the whole process down: floor at 8.
      resourceLimits: { maxOldGenerationSizeMb: Math.max(8, limits.maxHeapMb), maxYoungGenerationSizeMb: 32 },
      // No inherited environment: the worker never sees secrets.
      env: {},
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => done(() => reject(new PdfRefusedError("timeout", limits))),
      limits.timeoutMs,
    );
    worker.once("message", (m: WorkerReply) => done(() => resolve(m)));
    worker.once("error", (e: Error & { code?: string }) =>
      done(() =>
        reject(
          new PdfRefusedError(e.code === "ERR_WORKER_OUT_OF_MEMORY" ? "out_of_memory" : "unreadable", limits),
        ),
      ),
    );
    worker.once("exit", () => done(() => reject(new PdfRefusedError("unreadable", limits))));
  });
}

async function read(
  data: Buffer,
  mode: "text" | "items",
  limits: PdfLimits,
): Promise<WorkerReply & { ok: true }> {
  if (data.length > limits.maxBytes) throw new PdfRefusedError("too_large", limits);
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new PdfRefusedError("unreadable", limits);
  const reply = await slot(() => runWorker(data, mode, limits));
  if (!reply.ok) throw new PdfRefusedError(reply.code, limits);
  return reply;
}

/** All text of a PDF, pages merged (the same text unpdf's extractText({ mergePages: true }) gives). */
export async function readPdfText(data: Buffer, limits: PdfLimits): Promise<string> {
  return (await read(data, "text", limits)).text ?? "";
}

/** Each page's positioned text items, for layout-aware reading (assessment score tables). */
export async function readPdfPages(data: Buffer, limits: PdfLimits): Promise<PdfTextItem[][]> {
  return (await read(data, "items", limits)).pages ?? [];
}
