import Link from "next/link";
import { ActionButton, UploadForm } from "@/components/actions";
import { AuditPanel } from "@/components/audit-panel";
import { ChecklistToggle, ExportButton, LetterReview } from "@/components/letter-review";
import { Status } from "@/components/status";
import { can } from "@/lib/permissions";
import { packetView } from "@/lib/services/packets";
import { planView } from "@/lib/services/plans";
import { asOfToday, requirePageCtx } from "@/lib/server/page-session";

export default async function PacketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageCtx();
  const asOf = asOfToday();
  const [pv, plan] = await Promise.all([packetView(ctx, id, asOf), planView(ctx, id, asOf)]);
  const b = pv.bundle;
  const unapproved = plan.sections.filter((s) => s.state !== "approved").length;
  const blocked = unapproved > 0 || plan.blockers.length > 0;
  return (
    <>
      <p>
        <Link href={`/plans/${id}`}>← Plan</Link>
      </p>
      <h1>
        Reauth packet: {b.client.firstName} {b.client.lastName}
      </h1>
      <p>
        Hand-off status:{" "}
        <span className="badge info" data-testid="packet-status">
          {pv.packet?.status ?? "draft"}
        </span>
        {pv.packet?.exportedAt && (
          <span className="muted">
            {" "}
            · exported {pv.packet.exportedAt.toISOString().slice(0, 16).replace("T", " ")} · sha256{" "}
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
          <table>
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
                  <td>
                    <Status s={i.done ? "ok" : i.status} />
                  </td>
                  <td>
                    {i.label}
                    {i.action && <div className="muted">Suggested action: {i.action}</div>}
                  </td>
                  <td className="muted">{i.source.replace("_", " ")}</td>
                  <td>
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
            Export is blocked: {unapproved} section(s) not approved; {plan.blockers.length} audit check(s)
            failing.
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
