import { sampleFile } from "@/lib/demo";
import { api, readUpload } from "@/lib/server/api";
import { uploadVbmapp } from "@/lib/services/vbmapp";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  // ?sample=<name> loads one of the bundled synthetic workbooks (used by the demo site).
  const sample = new URL(req.url).searchParams.get("sample");
  const { filename, data } = sample
    ? { filename: sample, data: sampleFile("vbmapp", sample) }
    : await readUpload(req, 10 * 1024 * 1024);
  const r = await uploadVbmapp(ctx, id, filename, data);
  return { importId: r.importId };
});
