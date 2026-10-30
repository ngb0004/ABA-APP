import type { Metadata } from "next";
import Link from "next/link";
import { ImportReview, type ReviewScale } from "@/components/assessment-import-review";
import {
  KIND_LABELS,
  SCALE_KINDS,
  assessmentCatalog,
  catalogType,
  scaleBounds,
  scalesFor,
} from "@/lib/assessments/catalog";
import { can } from "@/lib/permissions";
import { assessmentImportReview } from "@/lib/services/assessment-imports";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Review score import" };

const FORMAT_LABELS: Record<string, string> = {
  xlsx: "Excel workbook",
  xls: "Excel workbook",
  csv: "CSV file",
  pdf: "PDF (text layer)",
  image: "image (read with OCR)",
  txt: "text file",
  docx: "Word file",
};

export default async function AssessmentImportPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const { import: imp, proposal } = await orNotFound(() => assessmentImportReview(ctx, id));
  const catalog = assessmentCatalog();
  const type = catalogType(catalog, imp.typeKey);
  const moduleName = type?.modules.find((m) => m.key === imp.module)?.name;
  const scales: ReviewScale[] = type
    ? scalesFor(type, imp.module).map((s) => ({
        key: s.key,
        name: s.name,
        kind: s.kind,
        kindLabel: KIND_LABELS[s.kind],
        parent: s.parent ?? null,
        ...scaleBounds(s),
      }))
    : [];
  const back = `/clients/${imp.clientId}/assessments`;
  return (
    <>
      <p>
        <Link href={back}>
          ← Assessments ({imp.client.firstName} {imp.client.lastName})
        </Link>
      </p>
      <h1>Review score import</h1>
      <p className="page-sub">
        {type?.name ?? imp.typeKey}
        {moduleName ? `: ${moduleName}` : ""} from {imp.filename}, a {FORMAT_LABELS[imp.format] ?? imp.format}
        . Check every number against the file before confirming; nothing is saved until you do. The file
        itself was not kept.
      </p>
      {imp.status !== "pending" ? (
        <div className="panel" data-testid="import-closed">
          <p>
            <span className={`badge ${imp.status === "confirmed" ? "ok" : "na"}`}>{imp.status}</span>{" "}
            {imp.status === "confirmed"
              ? "These scores were confirmed and saved as an assessment."
              : "This import was discarded; nothing was saved."}
          </p>
          <Link href={back}>Back to assessments</Link>
        </div>
      ) : (
        <ImportReview
          importId={imp.id}
          clientId={imp.clientId}
          scales={scales}
          proposal={proposal}
          phiDetected={imp.phiDetected}
          forms={(type?.forms ?? []).map((f) => ({ value: f.key, label: f.name }))}
          respondents={(type?.respondents ?? []).map((r) => ({ value: r.key, label: r.name }))}
          customScales={!!type?.customScales}
          kinds={SCALE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
          canConfirm={can(ctx.role, "assessment:confirm")}
          canDiscard={can(ctx.role, "assessment:write")}
          today={asOfToday()}
        />
      )}
    </>
  );
}
