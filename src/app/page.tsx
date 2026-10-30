import type { Metadata } from "next";
import { APP_NAME } from "@/lib/brand";
import Link from "next/link";
import { caseload, clientDetail } from "@/lib/services/clients";
import { asOfToday, requirePageCtx } from "@/lib/server/page-session";

// The root page shares the layout's segment, so the title template does not apply: spell it out.
export const metadata: Metadata = { title: { absolute: `Caseload · ${APP_NAME}` } };

export default async function CaseloadPage() {
  const ctx = await requirePageCtx();
  const asOf = asOfToday();
  const { events, clients } = await caseload(ctx, asOf);
  const details = await Promise.all(clients.map((c) => clientDetail(ctx, c.id, asOf)));
  const alertCount = details.reduce((n, d) => n + d.alerts.length, 0);
  const urgent = details.filter((d) => d.alerts.some((a) => a.level === "danger")).length;
  return (
    <>
      <h1>Caseload</h1>
      <p className="page-sub">Everything due in the next 60 days, as of {asOf}.</p>
      <div className="stats">
        <div className="stat dark">
          <div className="stat-label">Clients</div>
          <div className="stat-value">{clients.length}</div>
          <div className="stat-note">on your caseload</div>
        </div>
        <div className="stat gold">
          <div className="stat-label">Due soon</div>
          <div className="stat-value">{events.length}</div>
          <div className="stat-note">deadlines in the next 60 days</div>
        </div>
        <div className="stat">
          <div className="stat-label">Alerts</div>
          <div className="stat-value">{alertCount}</div>
          <div className="stat-note">across all clients</div>
        </div>
        <div className="stat green">
          <div className="stat-label">Need attention</div>
          <div className="stat-value">{urgent}</div>
          <div className="stat-note">clients with an urgent alert</div>
        </div>
      </div>
      <div className="grid2">
        <div className="panel">
          <h2>Due in the next 60 days</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Item</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>{e.date}</td>
                    <td>
                      <Link href={`/clients/${e.clientId}`}>{e.clientName}</Link>
                    </td>
                    <td>
                      {e.label}
                      {e.ruleId && e.verified === false && (
                        <span className="badge warn" style={{ marginLeft: 6 }}>
                          unverified rule
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <h2>Alerts</h2>
          {details.map((d) => (
            <div key={d.client.id} style={{ marginBottom: 10 }}>
              <strong>
                <Link href={`/clients/${d.client.id}`}>
                  {d.client.preferredName || d.client.firstName} {d.client.lastName}
                </Link>
              </strong>
              {d.alerts.length === 0 && <div className="muted">No alerts</div>}
              {d.alerts.map((a, i) => (
                <div key={i} className={`alert ${a.level}`}>
                  {a.message}
                  {a.source && <span className="alert-source"> · Source: {a.source}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
