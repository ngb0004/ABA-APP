import Link from "next/link";
import { caseload, clientDetail } from "@/lib/services/clients";
import { asOfToday, requirePageCtx } from "@/lib/server/page-session";

export default async function CaseloadPage() {
  const ctx = await requirePageCtx();
  const asOf = asOfToday();
  const { events, clients } = await caseload(ctx, asOf);
  const details = await Promise.all(clients.map((c) => clientDetail(ctx, c.id, asOf)));
  return (
    <>
      <h1>Caseload</h1>
      <p className="muted">As of {asOf}. Everything due in the next 60 days.</p>
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
                    <td>{e.date}</td>
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
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
