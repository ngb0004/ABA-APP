import { api, readUpload } from "@/lib/server/api";
import { uploadVbmapp } from "@/lib/services/vbmapp";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const { filename, data } = await readUpload(req, 10 * 1024 * 1024);
  const r = await uploadVbmapp(ctx, id, filename, data);
  return { importId: r.importId };
});
