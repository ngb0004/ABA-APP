import type { Metadata } from "next";
import Link from "next/link";
import { inactiveReasonLabel, statusFromParam } from "@/lib/client-status";
import { toDay } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { listClients } from "@/lib/services/clients";
import { requirePageCtx } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const ctx = await requirePageCtx();
  // Inactive (discontinued) clients are a separate folder: their own tab, out of the caseload.
  const status = statusFromParam((await searchParams).status);
  const { clients, counts } = await listClients(ctx, status);
  const inactive = status === "inactive";
  return (
    <>
      <h1>Clients</h1>
      {can(ctx.role, "client:write") && (
        <p>
          <Link className="btn" href="/clients/new" data-testid="new-client">
            New client
          </Link>
        </p>
      )}
      <nav className="tabs" aria-label="Client status">
        <Link href="/clients" aria-current={inactive ? undefined : "page"} data-testid="tab-active">
          Active ({counts.active})
        </Link>
        <Link
          href="/clients?status=inactive"
          aria-current={inactive ? "page" : undefined}
          data-testid="tab-inactive"
        >
          Inactive ({counts.inactive})
        </Link>
      </nav>
      {inactive && (
        <p className="muted">
          Discontinued clients. They raise no alerts or due dates, and their records stay here, readable and
          unchanged. Open one to reactivate it.
        </p>
      )}
      <div className="panel table-wrap">
        <table data-testid="clients-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Payor</th>
              <th>Authorization</th>
              <th>Ends</th>
              {inactive && <th>Inactive since</th>}
              {inactive && <th>Reason</th>}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/clients/${c.id}`}>
                    {c.firstName} {c.lastName}
                  </Link>{" "}
                  {c.isSynthetic && <span className="badge info">synthetic</span>}
                </td>
                <td>
                  {c.payors
                    .map((p) => `${p.payor.name}${p.priority === "secondary" ? " (secondary)" : ""}`)
                    .join(", ")}
                </td>
                <td>{c.authorizations[0]?.authNumber ?? "None"}</td>
                <td>{c.authorizations[0] ? toDay(c.authorizations[0].endDate) : ""}</td>
                {inactive && <td>{c.inactiveSince ? toDay(c.inactiveSince) : ""}</td>}
                {inactive && <td>{inactiveReasonLabel(c.inactiveReason)}</td>}
              </tr>
            ))}
            {!clients.length && (
              <tr>
                <td colSpan={inactive ? 6 : 4} className="muted">
                  {inactive ? "No inactive clients." : "No active clients."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
