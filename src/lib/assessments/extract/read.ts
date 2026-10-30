/**
 * Turns an uploaded file into lines of cells with locations. Data only: workbooks are read
 * with SheetJS without macros or formulas (rule 8), PDFs by their text layer, images by local
 * OCR (tesseract.js with the bundled English data; nothing is fetched at run time), Word files
 * by mammoth. Nothing read here is stored, logged, or sent anywhere.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { looksLikePhiInNote } from "../../rules-watch/text";
import { HttpError } from "../../log";
import { splitCells, textLine, type Cell, type Line } from "./lines";
import type { ImportFormat } from "./match";

const MAX_LINES = 5000;
const MAX_SHEETS = 20;
const MAX_PAGES = 40;

const cap = (lines: Line[]) => lines.slice(0, MAX_LINES);

/** Text cells are split further ("Autism Composite: 63"); every part keeps the cell's location. */
function splitCell(c: Cell): Cell[] {
  if (c.num !== undefined || c.date !== undefined) return [c];
  return splitCells(c.text).map((text) => ({ ...c, text }));
}

// ---------------------------------------------------------------- workbooks and CSV

/** A sheet's name in locations, unless it could be a person's name ("Smith Jane"): then its number. */
function sheetLabel(name: string, n: number): string {
  const safe =
    /^[A-Za-z0-9 _.()-]{1,31}$/.test(name) &&
    !/\b[A-Z][a-z]+[ _,]+[A-Z][a-z]+\b/.test(name) &&
    !looksLikePhiInNote(name);
  return safe ? name : `Sheet ${n}`;
}

export function sheetLines(data: Buffer, format: "xlsx" | "xls" | "csv"): Line[] {
  let wb: XLSX.WorkBook;
  try {
    wb =
      format === "csv"
        ? // CSV: every cell stays text, so "14 of 32" and dates are read by our parsers, not guessed.
          XLSX.read(data.toString("utf8").replace(/^﻿/, ""), { type: "string", raw: true, dense: false })
        : XLSX.read(data, {
            type: "buffer",
            bookVBA: false,
            cellFormula: false,
            cellHTML: false,
            cellNF: true,
            cellDates: false,
            sheetStubs: false,
          });
  } catch {
    throw new HttpError(400, "This file could not be read as a spreadsheet");
  }
  const lines: Line[] = [];
  wb.SheetNames.slice(0, MAX_SHEETS).forEach((name, si) => {
    const ws = wb.Sheets[name]!;
    if (!ws["!ref"]) return;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const label = format === "csv" ? null : sheetLabel(name, si + 1);
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + MAX_LINES); r++) {
      const cells: Cell[] = [];
      for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 60); c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr] as XLSX.CellObject | undefined;
        if (!cell || cell.v === undefined || cell.v === null || cell.t === "e") continue;
        const where = label ? `${label}!${addr}` : `cell ${addr}`;
        const col = c - range.s.c;
        if (cell.t === "n" && typeof cell.v === "number") {
          if (cell.z && XLSX.SSF.is_date(cell.z)) {
            const d = XLSX.SSF.parse_date_code(cell.v);
            const day = `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
            cells.push({ text: day, where, date: day, col });
          } else cells.push({ text: cell.w ?? String(cell.v), where, num: cell.v, col });
        } else if (cell.t === "s" || cell.t === "b" || cell.t === "d") {
          const text = String(cell.w ?? cell.v).trim();
          if (text) cells.push(...splitCell({ text, where, col }));
        }
      }
      if (cells.length)
        lines.push({ where: label ? `${label}!row ${r + 1}` : `row ${r + 1}`, cells, group: name });
    }
  });
  return cap(lines);
}

// ---------------------------------------------------------------- plain text

export function textFileLines(data: Buffer): Line[] {
  const text = data.toString("utf8").replace(/^﻿/, "");
  const lines: Line[] = [];
  text.split(/\r?\n|\f/).forEach((raw, i) => {
    const l = textLine(raw, `line ${i + 1}`, "text");
    if (l) lines.push(l);
  });
  return cap(lines);
}

// ---------------------------------------------------------------- PDF

type PdfItem = { str: string; x: number; y: number; w: number; h: number };

/** Groups a page's text items into lines (by baseline) and cells (by horizontal gaps). */
export function pdfPageLines(items: PdfItem[], page: number): Line[] {
  const words = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfItem[][] = [];
  for (const it of words) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0]!.y - it.y) <= Math.max(2, it.h * 0.4)) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap((row, i): Line[] => {
    row.sort((a, b) => a.x - b.x);
    const where = `page ${page}, line ${i + 1}`;
    const texts: string[] = [];
    let end = -Infinity;
    for (const it of row) {
      const gap = it.x - end;
      if (texts.length && gap < Math.max(6, it.h * 1.2))
        texts[texts.length - 1] += (gap > it.h * 0.15 ? " " : "") + it.str.trim();
      else texts.push(it.str.trim());
      end = it.x + it.w;
    }
    const cells = texts.flatMap((t) => splitCells(t).map((text) => ({ text, where })));
    return cells.length ? [{ where, cells, group: `page ${page}` }] : [];
  });
}

export async function pdfLines(data: Buffer): Promise<Line[]> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch {
    throw new HttpError(400, "This PDF could not be read");
  }
  try {
    const lines: Line[] = [];
    for (let p = 1; p <= Math.min(pdf.numPages, MAX_PAGES); p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = (
        content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]
      )
        .filter((i) => typeof i.str === "string" && Array.isArray(i.transform))
        .map((i) => ({
          str: i.str!,
          x: i.transform![4]!,
          y: i.transform![5]!,
          w: i.width ?? 0,
          h: i.height || Math.abs(i.transform![3]!) || 10,
        }));
      lines.push(...pdfPageLines(items, p));
    }
    if (!lines.some((l) => l.cells.some((c) => /[A-Za-z]{2}/.test(c.text))))
      throw new HttpError(
        422,
        "No text found in this PDF (it may be a scan). Try a photo or screenshot of the page (.png or .jpg), or enter the scores by hand.",
      );
    return cap(lines);
  } finally {
    await (pdf as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- images (local OCR)

type OcrWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };

/** One OCR line's words as cells: a gap wider than about one and a half word heights starts a new cell. */
export function ocrLineCells(words: OcrWord[], where: string): Cell[] {
  const ws = words.filter((w) => w.text.trim());
  if (!ws.length) return [];
  const heights = ws.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const h = heights[Math.floor(heights.length / 2)] || 10;
  const groups: OcrWord[][] = [];
  for (const w of ws) {
    const g = groups.at(-1);
    if (g && w.bbox.x0 - g.at(-1)!.bbox.x1 < h * 1.5) g.push(w);
    else groups.push([w]);
  }
  return groups.flatMap((g) => {
    const conf = Math.round(Math.min(...g.map((w) => w.confidence)));
    return splitCells(g.map((w) => w.text.trim()).join(" ")).map((text) => ({ text, where, conf }));
  });
}

/**
 * The English model shipped in node_modules (@tesseract.js-data/eng, a direct dependency), LSTM
 * "best int" variant. Read from disk: tesseract.js never fetches it from a CDN.
 */
export function ocrLangPath(): string {
  return path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
}

let ocrQueue: Promise<unknown> = Promise.resolve();
const OCR_TIMEOUT_MS = 90_000;

export async function imageLines(data: Buffer): Promise<Line[]> {
  // One OCR job at a time: each runs a worker thread with its own copy of the model.
  const run = ocrQueue.then(() => ocr(data));
  ocrQueue = run.catch(() => undefined);
  return run;
}

async function ocr(data: Buffer): Promise<Line[]> {
  const langPath = ocrLangPath();
  if (!existsSync(path.join(langPath, "eng.traineddata.gz")))
    throw new HttpError(503, "Reading images is not available on this server (OCR language data missing)");
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    langPath,
    cacheMethod: "none",
    gzip: true,
    errorHandler: () => undefined,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HttpError(422, "Reading the image took too long. Try a smaller image.")),
        OCR_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([worker.recognize(data, {}, { blocks: true, text: false }), timeout]);
    const lines: Line[] = [];
    let n = 0;
    for (const block of result.data.blocks ?? [])
      for (const para of block.paragraphs)
        for (const line of para.lines) {
          n += 1;
          const where = `OCR line ${n}`;
          const cells = ocrLineCells(line.words, where);
          if (cells.length) lines.push({ where, cells, group: "image" });
        }
    if (!lines.length)
      throw new HttpError(
        422,
        "No text found in this image. Try a clearer image, or enter the scores by hand.",
      );
    return cap(lines);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "This image could not be read");
  } finally {
    clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- Word (.docx)

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};
const htmlText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();

/** Paragraphs and table rows from mammoth's HTML, with "paragraph n" / "table t, row r" locations. */
export function docxHtmlLines(html: string): Line[] {
  const lines: Line[] = [];
  let para = 0;
  let table = 0;
  for (const part of html.split(/(<table[\s\S]*?<\/table>)/i)) {
    if (/^<table/i.test(part)) {
      table += 1;
      let row = 0;
      for (const tr of part.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        row += 1;
        const where = `table ${table}, row ${row}`;
        // Each cell keeps its column, so an empty <td> does not shift the ones after it.
        const cells = [...tr[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].flatMap((td, col) =>
          splitCells(htmlText(td[1]!)).map((text) => ({ text, where, col })),
        );
        if (cells.length) lines.push({ where, cells, group: `table ${table}` });
      }
    } else
      for (const p of part.matchAll(/<(p|h[1-6]|li)[^>]*>([\s\S]*?)<\/\1>/gi)) {
        para += 1;
        const l = textLine(htmlText(p[2]!), `paragraph ${para}`, "body");
        if (l) lines.push(l);
      }
  }
  return cap(lines);
}

export async function docxLines(data: Buffer): Promise<Line[]> {
  const mammoth = (await import("mammoth")).default;
  try {
    const { value } = await mammoth.convertToHtml(
      { buffer: data },
      { convertImage: mammoth.images.imgElement(async () => ({ src: "" })), ignoreEmptyParagraphs: true },
    );
    return docxHtmlLines(value);
  } catch {
    throw new HttpError(400, "This Word file could not be read");
  }
}

// ---------------------------------------------------------------- any format

export async function readLines(format: ImportFormat, data: Buffer): Promise<Line[]> {
  switch (format) {
    case "xlsx":
    case "xls":
    case "csv":
      return sheetLines(data, format);
    case "txt":
      return textFileLines(data);
    case "pdf":
      return pdfLines(data);
    case "image":
      return imageLines(data);
    case "docx":
      return docxLines(data);
  }
}
