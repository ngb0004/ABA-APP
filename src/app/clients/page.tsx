import Link from "next/link";
import { listClients } from "@/lib/services/clients";
import { requirePageCtx } from "@/lib/server/page-session";

export default async function ClientsPage() {
  const ctx = await requirePageCtx();
  const clients = await listClients(ctx);
  return (
    <>
      <h1>Clients</h1>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Payor</th>
              <th>Authorization</th>
              <th>Ends</th>
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
                <td>{c.authorizations[0] ? c.authorizations[0].endDate.toISOString().slice(0, 10) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
