import { sampleFile } from "@/lib/demo";
import { api, readUpload } from "@/lib/server/api";
import { withOrg } from "@/lib/db";
import { uploadLetter } from "@/lib/services/letters";

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  // ?sample=<name> loads one of the bundled synthetic letters (used by the demo site).
  const sample = new URL(req.url).searchParams.get("sample");
  const { filename, data } = sample
    ? { filename: sample, data: sampleFile("letters", sample) }
    : await readUpload(req, 5 * 1024 * 1024);
  const plan = await withOrg(ctx, (tx) => tx.plan.findUniqueOrThrow({ where: { id } }));
  return uploadLetter(ctx, plan.clientId, filename, data);
});
