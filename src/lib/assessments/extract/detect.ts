/**
 * Which kind of file an upload really is, from its first bytes (magic numbers), checked against
 * its extension. An upload whose contents do not match its name is rejected before it is read.
 */
import { HttpError } from "../../log";
import type { ImportFormat } from "./match";

export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
/** For the file picker. */
export const IMPORT_ACCEPT = ".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.txt,.docx";

const EXTENSIONS: Record<string, ImportFormat> = {
  xlsx: "xlsx",
  xls: "xls",
  csv: "csv",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  txt: "txt",
  docx: "docx",
};

export type DetectedFile = { format: ImportFormat; mime: string; extension: string };

const starts = (data: Buffer, bytes: number[], at = 0) => bytes.every((b, i) => data[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** What the bytes say, regardless of the name: a format and its media type, or null. */
export function sniff(data: Buffer): { kind: string; mime: string } | null {
  if (starts(data, ascii("%PDF-"))) return { kind: "pdf", mime: "application/pdf" };
  if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: "png", mime: "image/png" };
  if (starts(data, [0xff, 0xd8, 0xff])) return { kind: "jpeg", mime: "image/jpeg" };
  if (starts(data, ascii("RIFF")) && starts(data, ascii("WEBP"), 8))
    return { kind: "webp", mime: "image/webp" };
  if (starts(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return { kind: "xls", mime: "application/vnd.ms-excel" };
  if (starts(data, [0x50, 0x4b, 0x03, 0x04])) {
    // Office files are zip packages; their part names are stored uncompressed.
    const names = data.toString("latin1");
    if (names.includes("xl/workbook.xml") || names.includes("xl/workbook.bin"))
      return { kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    if (names.includes("word/document.xml"))
      return {
        kind: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
    return { kind: "zip", mime: "application/zip" };
  }
  if (isPlainText(data)) return { kind: "text", mime: "text/plain" };
  return null;
}

/** UTF-8 text with no control bytes other than tab, line feed, carriage return, and form feed. */
function isPlainText(data: Buffer): boolean {
  const head = data.subarray(0, 64 * 1024);
  for (const b of head) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

const MATCHES: Record<ImportFormat, string[]> = {
  xlsx: ["xlsx"],
  xls: ["xls"],
  csv: ["text"],
  pdf: ["pdf"],
  image: ["png", "jpeg", "webp"],
  txt: ["text"],
  docx: ["docx"],
};

/** The upload's format. 413 when too large; 400 when unsupported or its contents do not match its name. */
export function detectFormat(filename: string, data: Buffer): DetectedFile {
  if (data.length > MAX_IMPORT_BYTES) throw new HttpError(413, "File too large (15 MB max)");
  if (!data.length) throw new HttpError(400, "The file is empty");
  const extension = (/\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1] ?? "").toLowerCase();
  const format = EXTENSIONS[extension];
  if (!format)
    throw new HttpError(
      400,
      "Upload an Excel workbook (.xlsx, .xls), a .csv, a PDF, an image (.png, .jpg, .webp), a .txt, or a Word file (.docx)",
    );
  const got = sniff(data);
  if (!got || !MATCHES[format].includes(got.kind))
    throw new HttpError(400, `The file's contents do not match its .${extension} name`);
  return { format, mime: format === "csv" ? "text/csv" : got.mime, extension };
}
