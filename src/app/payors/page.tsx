import { RuleSource } from "@/components/status";
import { VerifyRule } from "@/components/verify-rule";
import { withOrg } from "@/lib/db";
import { can, requirePermission } from "@/lib/permissions";
import { loadRules } from "@/lib/services/payors";
import { requirePageCtx } from "@/lib/server/page-session";

export default async function PayorsPage() {
  const ctx = await requirePageCtx();
  requirePermission(ctx.role, "payor:read");
  const payors = await withOrg(ctx, async (tx) => {
    const list = await tx.payor.findMany({ orderBy: { name: "asc" } });
    return Promise.all(list.map(async (p) => ({ ...p, rules: await loadRules(tx, p.id) })));
  });
  return (
    <>
      <h1>Payor rules</h1>
      <p className="alert warn">
        Rules are data with a cited source. Unverified rules only ever produce warnings. Verify a rule only
        after checking it against the cited official document, and record the section you checked.
      </p>
      {payors.map((p) => (
        <details className="panel" key={p.id}>
          <summary>
            <strong>{p.name}</strong>{" "}
            <span className="muted">
              ({p.rules.length} rules{p.inherits ? `, inherits ${p.inherits}` : ""};{" "}
              {p.rules.filter((r) => r.verified).length} verified)
            </span>
          </summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Parameters</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {p.rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.type.replace(/_/g, " ")}</td>
                    <td>
                      <code style={{ fontSize: 12 }}>{JSON.stringify(r.params)}</code>
                      {r.notes && <div className="muted">{r.notes}</div>}
                    </td>
                    <td>
                      <RuleSource r={r} />
                    </td>
                    <td>
                      {can(ctx.role, "payor:verify") && !r.inheritedFrom && (
                        <VerifyRule ruleId={r.id} verified={r.verified} section={r.source.section} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </>
  );
}
