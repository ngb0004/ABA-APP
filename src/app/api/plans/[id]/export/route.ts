import { HttpError } from "@/lib/log";
import { api } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { downloadPacketPdf, exportPacketPdf } from "@/lib/services/packets";

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
  const pdf = await downloadPacketPdf(ctx, id);
  // The file is gone (e.g. the server restarted); the packet record remains.
  if (!pdf) throw new HttpError(404, "The exported file is no longer available. Export the packet again.");
  return pdfResponse(pdf, id);
});
