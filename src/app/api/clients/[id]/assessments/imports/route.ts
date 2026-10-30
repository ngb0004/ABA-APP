import { sampleFile } from "@/lib/demo";
import { MAX_IMPORT_BYTES } from "@/lib/assessments/extract/detect";
import { api, readUpload } from "@/lib/server/api";
import { uploadAssessmentImport } from "@/lib/services/assessment-imports";

// Local OCR and PDF reading need Node (never the edge runtime).
export const runtime = "nodejs";

/** "vineland_3" or "afls:basic_living" (type and module), as the type dropdown sends it. */
const splitType = (v: string | null) => {
  const [typeKey, module] = (v ?? "").split(":");
  return { typeKey: typeKey ?? "", module: module || null };
};

export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  // ?sample=<name>&type=<type> loads one of the bundled synthetic score files (used by the demo site).
  const params = new URL(req.url).searchParams;
  const sample = params.get("sample");
  const upload = sample
    ? { filename: sample, data: sampleFile("assessments", sample), type: params.get("type") }
    : await readUpload(req, MAX_IMPORT_BYTES).then((u) => ({ ...u, type: u.fields.type ?? null }));
  const r = await uploadAssessmentImport(ctx, id, {
    filename: upload.filename,
    data: upload.data,
    ...splitType(upload.type),
  });
  return { importId: r.importId };
});
