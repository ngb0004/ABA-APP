import { SamplePicker } from "@/components/row-menu";
import type { Metadata } from "next";
import Link from "next/link";
import { sectionDone } from "@/lib/plan/sections";
import { ActionButton, UploadForm } from "@/components/actions";
import { DEMO_SAMPLES, isDemo } from "@/lib/demo";
import { AuditPanel } from "@/components/audit-panel";
import { ChecklistToggle, ExportButton, LetterReview } from "@/components/letter-review";
import { Status } from "@/components/status";
import { withOrg } from "@/lib/db";
import { can } from "@/lib/permissions";
import { packetView } from "@/lib/services/packets";
import { planView } from "@/lib/services/plans";
import { practiceTimeZone } from "@/lib/services/clients";
import { formatDateTime } from "@/lib/time-format";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Packet and export" };

export default async function PacketPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const asOf = asOfToday();
  const [pv, plan, timeZone] = await orNotFound(() =>
    Promise.all([packetView(ctx, id, asOf), planView(ctx, id, asOf), practiceTimeZone(ctx)]),
  );
  const b = pv.bundle;
  const initial = plan.bundle.plan.type !== "reauth";
  // Name the payor document behind each payor-rule row, so similar rows from two payors can be told apart.
  const ruleIds = pv.checklist.filter((i) => i.key.startsWith("rule:")).map((i) => i.key.slice(5));
  const ruleSources = new Map(
    (ruleIds.length
      ? await withOrg(ctx, (tx) =>
          tx.payorRule.findMany({
            where: { id: { in: ruleIds } },
            select: {
              id: true,
              payor: { select: { name: true } },
              sourceDocument: { select: { name: true } },
            },
          }),
        )
      : []
    ).map((r) => [
      `rule:${r.id}`,
      r.sourceDocument ? `${r.payor.name}: ${r.sourceDocument.name}` : r.payor.name,
    ]),
  );
  const unapproved = plan.sections.filter((s) => !sectionDone(s.state)).length;
  const blocked = unapproved > 0 || plan.blockers.length > 0;
  return (
    <>
      <p>
        <Link href={`/plans/${id}`}>← Plan</Link>
      </p>
      <h1>
        {initial ? "Initial request packet" : "Reauthorization packet"}: {b.client.firstName}{" "}
        {b.client.lastName}
      </h1>
      <p>
        Hand-off status:{" "}
        <span className="badge info" data-testid="packet-status">
          {pv.packet?.status ?? "draft"}
        </span>
        {pv.packet?.exportedAt && (
          <span className="muted">
            {" "}
            · exported {formatDateTime(pv.packet.exportedAt, timeZone)} · sha256{" "}
            {pv.packet.pdfSha256?.slice(0, 12)}…
          </span>
        )}
      </p>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Payor letters</h2>
        {can(ctx.role, "letter:upload") && (
          <UploadForm
            url={`/api/plans/${id}/letters`}
            accept=".pdf,.txt"
            label="Upload a payor letter (PDF or text)"
            testId="letter-upload"
          />
        )}
        {can(ctx.role, "letter:upload") && isDemo() && (
          <p className="muted">
            Uploading your own files is turned off on the demo site. Only the fictional sample letters below
            are accepted.
          </p>
        )}
        {can(ctx.role, "letter:upload") && (
          <SamplePicker
            label={`Or load a fictional sample letter${initial ? " (reauthorization letters)" : ""}`}
            urlPrefix={`/api/plans/${id}/letters?sample=`}
            samples={DEMO_SAMPLES.letters}
            testId="sample-letters"
          />
        )}
        {b.letters.map((l) => (
          <LetterReview
            key={l.id}
            letter={{
              id: l.id,
              filename: l.filename,
              status: l.status,
              classification: l.classification,
              extracted: l.extracted as never,
            }}
          />
        ))}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Checklist</h2>
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>Status</th>
                <th>Item</th>
                <th>Source</th>
                <th>Done</th>
              </tr>
            </thead>
            <tbody>
              {pv.checklist.map((i) => (
                <tr key={i.key}>
                  <td data-label="">
                    <Status s={i.done ? "ok" : i.status} />
                  </td>
                  <td data-label="">
                    {i.label}
                    {i.action && <div className="muted">Suggested action: {i.action}</div>}
                  </td>
                  <td className="muted" data-label="Source">
                    {i.source.replace("_", " ")}
                    {ruleSources.get(i.key) && <div>{ruleSources.get(i.key)}</div>}
                  </td>
                  <td data-label="Done">
                    {i.source !== "auto" && can(ctx.role, "packet:manage") && (
                      <ChecklistToggle planId={id} itemKey={i.key} done={!!i.done} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Export</h2>
        {blocked ? (
          <div className="alert danger" data-testid="export-blocked">
            Export is blocked: {unapproved} {unapproved === 1 ? "section" : "sections"} not approved;{" "}
            {plan.blockers.length} audit {plan.blockers.length === 1 ? "check" : "checks"} failing.
          </div>
        ) : (
          <div className="alert info">All sections approved and the pre-submission audit passes.</div>
        )}
        <div className="row">
          {can(ctx.role, "export:pdf") && <ExportButton planId={id} disabled={blocked} />}
          {pv.packet?.exportedAt && (
            <a className="btn" href={`/api/plans/${id}/export`}>
              Download last export
            </a>
          )}
          {pv.packet?.status === "ready" && can(ctx.role, "packet:manage") && (
            <ActionButton url={`/api/plans/${id}/packet/submit`} testId="mark-submitted">
              Mark submitted
            </ActionButton>
          )}
        </div>
        <p className="muted">
          The PDF contains: cover and payor request form placeholder (with a link to the official form), the
          plan, goals with graphs, the VB-MAPP grid, the attachment index, and a table of sources for every
          figure.
        </p>
      </div>
      <AuditPanel checks={plan.checks} />
    </>
  );
}
