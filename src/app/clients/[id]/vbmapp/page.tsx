import { SamplePicker } from "@/components/row-menu";
import type { Metadata } from "next";
import Link from "next/link";
import { Html, UploadForm } from "@/components/actions";
import { DEMO_SAMPLES, isDemo } from "@/lib/demo";
import { withOrg } from "@/lib/db";
import { toDay } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requirePermission } from "@/lib/permissions";
import { renderMilestonesGridSvg } from "@/lib/vbmapp/grid-svg";
import type { Flag } from "@/lib/vbmapp/parse";
import { orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "VB-MAPP" };

export default async function VbmappPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "client:read");
  const { client, admins, pending } = await orNotFound(() =>
    withOrg(ctx, async (tx) => ({
      client: await tx.client.findUniqueOrThrow({ where: { id } }),
      admins: await tx.vbmappAdministration.findMany({
        where: { clientId: id },
        include: { scores: true },
        orderBy: { adminNumber: "asc" },
      }),
      pending: await tx.vbmappImport.findMany({
        where: { clientId: id, status: "pending" },
        orderBy: { createdAt: "desc" },
      }),
    })),
  );
  const legend = admins.map((a) => ({
    adminNumber: a.adminNumber,
    label: `Admin ${a.adminNumber}${a.testDate ? ` (${toDay(a.testDate)})` : ""}`,
  }));
  return (
    <>
      <p>
        <Link href={`/clients/${id}/assessments`}>
          ← Assessments ({client.firstName} {client.lastName})
        </Link>
      </p>
      <h1>VB-MAPP Milestones</h1>
      {can(ctx.role, "vbmapp:import") && (
        <div className="panel">
          <UploadForm
            url={`/api/clients/${id}/vbmapp`}
            accept=".xlsm,.xlsx"
            label="Import a VB-MAPP scoring workbook (.xlsm / .xlsx). Read as data only; macros are never run."
            redirectKey="importId"
            redirectPrefix="/vbmapp/imports/"
            testId="vbmapp-upload"
          />
          {isDemo() && (
            <p className="muted">
              Uploading your own files is turned off on the demo site. Only the fictional sample workbooks
              below are accepted.
            </p>
          )}
          <SamplePicker
            label="Or load a fictional sample workbook"
            urlPrefix={`/api/clients/${id}/vbmapp?sample=`}
            samples={DEMO_SAMPLES.vbmapp}
            redirectKey="importId"
            redirectPrefix="/vbmapp/imports/"
            testId="sample-workbooks"
          />
          {pending.length > 0 && (
            <p>
              Pending review:{" "}
              {pending.map((p) => (
                <Link key={p.id} href={`/vbmapp/imports/${p.id}`} style={{ marginRight: 8 }}>
                  {p.filename}
                </Link>
              ))}
            </p>
          )}
        </div>
      )}
      {admins.length === 0 && <p className="muted">No administrations yet.</p>}
      {admins.map((a) => {
        const totals = a.totals as { total: number; levels: Record<string, number> };
        const flags = a.flags as Flag[];
        return (
          <div className="panel" key={a.id} id={`admin-${a.adminNumber}`}>
            <h2 style={{ marginTop: 0 }}>
              Administration {a.adminNumber}{" "}
              {a.verified ? (
                <span className="badge ok">verified by BCBA</span>
              ) : (
                <span className="badge warn">unverified</span>
              )}
            </h2>
            <p>
              Date {a.testDate ? toDay(a.testDate) : "not valid"} · tester {a.testerInitials ?? "?"} ·
              recomputed total <strong>{totals.total}</strong> (L1 {totals.levels["1"]}, L2{" "}
              {totals.levels["2"]}, L3 {totals.levels["3"]})
              {a.reviewedAt && (
                <span className="muted">
                  {" "}
                  · reviewed {a.reviewedAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              )}
            </p>
            {flags.length > 0 && (
              <ul>
                {flags.map((f, i) => (
                  <li key={i} className={f.severity === "info" ? "muted" : undefined}>
                    <span className={`badge ${f.severity === "info" ? "info" : "warn"}`}>
                      {f.code.replace(/_/g, " ")}
                    </span>{" "}
                    {f.message}
                  </li>
                ))}
              </ul>
            )}
            <Html
              html={renderMilestonesGridSvg(
                a.scores.map((s) => ({
                  level: s.level,
                  domain: s.domain,
                  milestone: s.milestone,
                  score: s.score as 0.5 | 1,
                  firstAdmin: s.firstAdmin,
                  carriedForward: s.carriedForward,
                })),
                legend,
              )}
            />
            <p className="muted">
              Each administration has its own color. A half-filled cell is a half point; faded cells were
              carried forward from an earlier administration.
            </p>
          </div>
        );
      })}
    </>
  );
}
