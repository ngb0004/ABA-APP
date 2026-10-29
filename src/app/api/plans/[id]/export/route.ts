import { readFile } from "node:fs/promises";
import path from "node:path";
import { withOrg } from "@/lib/db";
import { HttpError } from "@/lib/log";
import { requirePermission } from "@/lib/permissions";
import { api } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { EXPORT_DIR, exportPacketPdf } from "@/lib/services/packets";

const pdfResponse = (pdf: Buffer, planId: string) =>
  new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="packet-${planId.slice(0, 8)}.pdf"`,
      "cache-control": "no-store",
    },
  });

export const POST = api<{ id: string }>(async (_req, ctx, { id }) =>
  pdfResponse((await exportPacketPdf(ctx, id, asOfToday())).pdf, id),
);

export const GET = api<{ id: string }>(async (_req, ctx, { id }) => {
  requirePermission(ctx.role, "export:pdf");
  const packet = await withOrg(ctx, (tx) => tx.packet.findUnique({ where: { planId: id } }));
  if (!packet?.exportedAt) throw new HttpError(404, "Not exported yet");
  return pdfResponse(await readFile(path.join(EXPORT_DIR, `${id}.pdf`)), id);
});
