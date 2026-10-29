import { Status } from "./status";

export function AuditPanel({
  checks,
}: {
  checks: {
    id: string;
    category: string;
    status: string;
    message: string;
    details?: string[];
    action?: string;
  }[];
}) {
  const order = { fail: 0, warn: 1, pass: 2 } as Record<string, number>;
  const sorted = [...checks].sort(
    (a, b) => order[a.status]! - order[b.status]! || a.category.localeCompare(b.category),
  );
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return (
    <div className="panel" data-testid="audit-panel">
      <h2 style={{ marginTop: 0 }}>Pre-submission audit</h2>
      <p>
        <span className="badge fail">{fails} blocking</span>{" "}
        <span className="badge warn">{warns} warnings</span>{" "}
        <span className="muted">Export is blocked until there are no blocking checks.</span>
      </p>
      <div className="table-wrap">
        <table>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id} data-check={c.id}>
                <td>
                  <Status s={c.status} />
                </td>
                <td className="muted">{c.category}</td>
                <td>
                  {c.message}
                  {c.action && <div className="muted">Action: {c.action}</div>}
                  {c.details && c.details.length > 0 && (
                    <details>
                      <summary className="muted">Details</summary>
                      <ul>
                        {c.details.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
