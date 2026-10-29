import Link from "next/link";
import { Html } from "@/components/actions";
import { ImportConfirm } from "@/components/import-confirm";
import { can } from "@/lib/permissions";
import { importReview } from "@/lib/services/vbmapp";
import { renderMilestonesGridSvg } from "@/lib/vbmapp/grid-svg";
import { requirePageCtx, uuidParam } from "@/lib/server/page-session";

export default async function ImportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const { import: imp, parsed, preview } = await importReview(ctx, id);
  return (
    <>
      <p>
        <Link href={`/clients/${imp.clientId}/vbmapp`}>← VB-MAPP</Link>
      </p>
      <h1>Review import: {imp.filename}</h1>
      <p className="muted">
        Status: {imp.status}. Totals below are recomputed from the raw grid; workbook totals are only
        compared, never used.
      </p>
      <div className="grid2">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Extracted grid</h2>
          {preview.length === 0 && <p>No administrations found in this workbook.</p>}
          {preview.map((a) => (
            <div key={a.adminNumber}>
              <h3>Administration {a.adminNumber}</h3>
              <p>
                Test date:{" "}
                {a.testDate ?? <span className="badge warn">invalid ({a.testDateRaw ?? "blank"})</span>} ·
                tester {a.testerInitials ?? "?"}
                <br />
                Recomputed total <strong data-testid="recomputed-total">{a.totals.total}</strong> (L1{" "}
                {a.totals.levels[1]}, L2 {a.totals.levels[2]}, L3 {a.totals.levels[3]}) · workbook says{" "}
                {a.workbookTotal ?? "blank"}
                {a.mergedTotals.total !== a.totals.total && (
                  <> · with carry-forward: {a.mergedTotals.total}</>
                )}
              </p>
              <Html
                html={renderMilestonesGridSvg(a.merged, [
                  { adminNumber: a.adminNumber, label: `Admin ${a.adminNumber}` },
                ])}
              />
            </div>
          ))}
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Validation flags ({parsed.flags.length})</h2>
          {parsed.flags.length === 0 && <p className="muted">No issues found.</p>}
          <ul>
            {parsed.flags.map((f, i) => (
              <li key={i} data-testid="import-flag">
                <span className={`badge ${f.severity === "info" ? "info" : "warn"}`}>
                  {f.code.replace(/_/g, " ")}
                </span>{" "}
                {f.message}
                <div className="muted">Cells: {f.cells.join(", ")}</div>
              </li>
            ))}
          </ul>
          {imp.status === "pending" && can(ctx.role, "vbmapp:confirm") && (
            <ImportConfirm importId={imp.id} clientId={imp.clientId} phiDetected={imp.phiDetected} />
          )}
        </div>
      </div>
    </>
  );
}
