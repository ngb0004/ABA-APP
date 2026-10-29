import { listAudit } from "@/lib/services/misc";
import { requirePageCtx } from "@/lib/server/page-session";

export default async function AuditPage() {
  const ctx = await requirePageCtx();
  const rows = await listAudit(ctx, 300);
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Append-only. Shows the most recent 300 events for this organization. IDs only; no client details are
        stored in audit metadata.
      </p>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>User</th>
              <th>Action</th>
              <th>Record</th>
              <th>Meta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap" }}>
                  {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="muted">{r.userId?.slice(0, 8) ?? "system"}</td>
                <td>{r.action}</td>
                <td>
                  {r.entityType} <span className="muted">{r.entityId?.slice(0, 8)}</span>
                </td>
                <td>
                  <code style={{ fontSize: 11 }}>{JSON.stringify(r.meta).slice(0, 160)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
