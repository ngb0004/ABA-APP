import { deflateSync } from "node:zlib";

/**
 * Builds small PDFs in memory for the PDF guard tests (nothing large is committed): `pages` pages
 * of Helvetica text, optionally a FlateDecode stream that unpacks to `bombBytes` (a decompression
 * bomb: megabytes of zeros compress to a few kilobytes), `chained` compressing it twice.
 */
export function buildPdf(opts: {
  pages?: number;
  text?: (page: number) => string;
  bombBytes?: number;
  chained?: boolean;
}): Buffer {
  const pages = opts.pages ?? 1;
  const text = opts.text ?? ((p) => `Synthetic page ${p}`);
  const objects: (string | Buffer)[] = [];
  const add = (body: string | Buffer) => objects.push(body); // object number = index + 1
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let p = 1; p <= pages; p++) {
    const id = 4 + (p - 1) * 2;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    const escaped = text(p).replace(/[\\()]/g, (c) => `\\${c}`);
    const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  if (opts.bombBytes) {
    let packed = deflateSync(Buffer.alloc(opts.bombBytes), { level: 9 });
    if (opts.chained) packed = deflateSync(packed, { level: 9 });
    const filter = opts.chained ? "[/FlateDecode /FlateDecode]" : "/FlateDecode";
    add(
      Buffer.concat([
        Buffer.from(`<< /Length ${packed.length} /Filter ${filter} >>\nstream\n`, "latin1"),
        packed,
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      typeof body === "string" ? Buffer.from(body, "latin1") : body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    offsets.push(offset);
    offset += chunk.length;
    parts.push(chunk);
  });
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(offset),
    "%%EOF",
  ].join("\n");
  parts.push(Buffer.from(xref + "\n", "latin1"));
  return Buffer.concat(parts);
}
