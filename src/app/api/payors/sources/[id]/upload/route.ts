import { api, readUpload } from "@/lib/server/api";
import { MAX_BYTES } from "@/lib/rules-watch/fetch";
import { uploadOfficialCopy } from "@/lib/services/rules-watch";

export const maxDuration = 120;

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const { data, fields } = await readUpload(req, MAX_BYTES);
  return uploadOfficialCopy(ctx, id, {
    data,
    versionLabel: fields.version ?? null,
    effectiveDate: fields.effectiveDate ?? null,
  });
});
