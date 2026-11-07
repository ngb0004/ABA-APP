// PDF reading in a worker thread (src/lib/pdf/guard.ts starts it with memory limits and a deadline).
// Plain JavaScript so it runs as-is under Next.js, tsx, and Vitest. Reads data only: no scripts,
// no fonts or files fetched, nothing stored. Replies with the text, or a refusal code.
import { parentPort, workerData } from "node:worker_threads";
import { inflateSync, constants } from "node:zlib";

const { data, mode, limits } = workerData;

class Refused extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isZlibHeader = (b) => b.length >= 2 && (b[0] & 0x0f) === 8 && ((b[0] << 8) | b[1]) % 31 === 0;

/**
 * Inflates every stream that is zlib-compressed (FlateDecode, also chained) with a hard cap on
 * the total output, before PDF.js decompresses anything: a few kilobytes can unpack to gigabytes.
 * Never trusts the /Length the file declares.
 */
function checkCompressedSize(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let budget = limits.maxInflatedBytes;
  let at = 0;
  let streams = 0;
  for (;;) {
    const s = buf.indexOf("stream", at, "latin1");
    if (s < 0) return;
    at = s + 6;
    // "endstream" also contains "stream"; skip it.
    if (s >= 3 && buf.toString("latin1", s - 3, s) === "end") continue;
    let start = at;
    if (buf[start] === 0x0d) start++;
    if (buf[start] !== 0x0a) continue;
    start++;
    const end = buf.indexOf("endstream", start, "latin1");
    if (end < 0) return;
    at = end + 9;
    if (++streams > limits.maxStreams) throw new Refused("too_large_unpacked");
    let body = buf.subarray(start, end);
    for (let depth = 0; depth < 4 && isZlibHeader(body); depth++) {
      let out;
      try {
        out = inflateSync(body, { maxOutputLength: budget + 1, finishFlush: constants.Z_SYNC_FLUSH });
      } catch (e) {
        if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError))
          throw new Refused("too_large_unpacked");
        break; // Not zlib data after all; PDF.js decides.
      }
      if (out.length > budget) throw new Refused("too_large_unpacked");
      budget -= out.length;
      body = out;
    }
  }
}

/** The same merge as unpdf's extractText({ mergePages: true }). */
const mergePages = (texts) =>
  texts
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

async function run() {
  checkCompressedSize(data);
  const { getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(data, { isEvalSupported: false, stopAtErrors: false });
  } catch {
    throw new Refused("unreadable");
  }
  if (pdf.numPages > limits.maxPages) throw new Refused("too_many_pages");
  let chars = 0;
  const texts = [];
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter((i) => typeof i.str === "string");
    for (const i of items) chars += i.str.length;
    if (chars > limits.maxTextChars) throw new Refused("too_much_text");
    if (mode === "items")
      pages.push(
        items
          .filter((i) => Array.isArray(i.transform))
          .map((i) => ({ str: i.str, transform: i.transform.slice(0, 6), width: i.width, height: i.height })),
      );
    else texts.push(items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join(""));
    page.cleanup?.();
  }
  await Promise.resolve(pdf.destroy?.()).catch(() => undefined);
  return mode === "items" ? { pages } : { text: mergePages(texts) };
}

run().then(
  (result) => parentPort.postMessage({ ok: true, ...result }),
  (e) => parentPort.postMessage({ ok: false, code: e instanceof Refused ? e.code : "unreadable" }),
);
