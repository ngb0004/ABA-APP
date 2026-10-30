import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton, Html } from "@/components/actions";
import { FlatExplanation, GoalMenu, GoalRecordEditor } from "@/components/goal-editor";
import { RecordForm } from "@/components/record-form";
import { Status } from "@/components/status";
import { toDay } from "@/lib/dates";
import { measureUnit } from "@/lib/plan/context";
import { can } from "@/lib/permissions";
import { goalsView } from "@/lib/services/goals";
import { asOfToday, orNotFound, requirePageCtx, uuidParam } from "@/lib/server/page-session";
import { ClientInactiveBanner } from "@/components/inactive-banner";

export const metadata: Metadata = { title: "Goals" };

export default async function GoalsPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await uuidParam(params);
  const ctx = await requirePageCtx();
  const asOf = asOfToday();
  const v = await orNotFound(() => goalsView(ctx, id, asOf));
  return (
    <>
      <p>
        <Link href={`/clients/${id}`}>
          ← {v.client.firstName} {v.client.lastName}
        </Link>
      </p>
      <h1>Goals</h1>
      <ClientInactiveBanner ctx={ctx} clientId={id} />
      <div className="grid2">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Required goal categories</h2>
          <ul>
            {v.categories.map((c) => (
              <li key={c.category}>
                <Status s={c.ok ? "pass" : "fail"} /> {c.message} ({c.found})
              </li>
            ))}
          </ul>
          <p>
            <Status s={v.duplicates.length ? "fail" : "pass"} /> Duplicate rationale check
            {v.duplicates.length ? `: ${v.duplicates.length} near-identical pair(s)` : ""}
          </p>
          <p>
            <Status s={v.unlinked.length ? "fail" : "pass"} /> Diagnosis/deficit links
            {v.unlinked.length ? `: ${v.unlinked.length} unlinked` : ""}
          </p>
        </div>
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Goal suggestions</h2>
          <h3>From VB-MAPP</h3>
          {!v.latestVerified ? (
            <p className="muted">Import and verify a VB-MAPP to get suggestions.</p>
          ) : (
            <div>
              {v.suggestions.map((s, i) => (
                <div key={i} className="list-row">
                  <div>
                    <strong>
                      Level {s.level} {s.domain}
                    </strong>
                    <div className="muted">
                      {s.domainScore} of {s.domainMax} · next milestone {s.nextMilestone}
                      {s.template ? ` · suggests ${s.template.domainName} tier ${s.template.tier}` : ""}
                    </div>
                  </div>
                  {s.template && can(ctx.role, "goal:write") && (
                    <ActionButton
                      url={`/api/clients/${id}/goals`}
                      body={{ templateId: s.template.id }}
                      secondary
                      small
                      ariaLabel={`Add ${s.template.domainName} tier ${s.template.tier}`}
                    >
                      + Add goal
                    </ActionButton>
                  )}
                </div>
              ))}
            </div>
          )}
          {v.areaSuggestions.length > 0 && (
            <div data-testid="area-suggestions">
              <h3>Lowest skill areas</h3>
              {v.areaSuggestions.map((s) => (
                <div
                  key={`${s.assessmentId}:${s.areaKey}`}
                  className="list-row"
                  data-testid="area-suggestion"
                >
                  <div>
                    <strong>
                      {s.assessmentName} {s.area}
                    </strong>
                    <div className="muted">
                      {s.value} of {s.possible} ({Math.round(s.share * 100)}%)
                      {s.administeredOn ? ` · ${s.administeredOn}` : ""}
                      {s.template
                        ? ` · suggests ${s.template.domainName} tier ${s.template.tier}`
                        : " · no template yet"}
                    </div>
                  </div>
                  {s.template && can(ctx.role, "goal:write") && (
                    <ActionButton
                      url={`/api/clients/${id}/goals`}
                      body={{ templateId: s.template.id }}
                      secondary
                      small
                      ariaLabel={`Add ${s.template.domainName} tier ${s.template.tier} for ${s.area}`}
                    >
                      + Add goal
                    </ActionButton>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {v.goals.map((g) => (
        <div className="panel" key={g.id} id={`goal-${g.ordinal}`}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <h2 style={{ marginTop: 0 }}>
              Goal {g.ordinal}: {g.domain}{" "}
              <span className="muted">
                tier {g.tier} · {g.category.replace("_", " ")} · {g.initiationWindow}
              </span>{" "}
              <Status s={g.status} />
              {g.progressStatus === "discontinued" && (
                <>
                  {" "}
                  <span className="badge na" data-testid={`discontinued-${g.ordinal}`}>
                    discontinued{g.discontinuedOn ? ` ${toDay(g.discontinuedOn)}` : ""}
                  </span>
                </>
              )}
            </h2>
            {can(ctx.role, "goal:write") && (
              <GoalMenu
                asOf={asOf}
                canRemove={can(ctx.role, "goal:approve")}
                removeBlocker={g.removeBlocker}
                goal={{
                  id: g.id,
                  ordinal: g.ordinal,
                  progressStatus: g.progressStatus,
                  objective: g.objective,
                  rationale: g.rationale,
                  masteryAccuracyPct: g.masteryAccuracyPct,
                  masteryConsecutiveSessions: g.masteryConsecutiveSessions,
                  masteryInstructors: g.masteryInstructors,
                }}
              />
            )}
          </div>
          {g.progressStatus === "discontinued" && g.discontinuedReason && (
            <p data-testid={`discontinued-reason-${g.ordinal}`}>
              <em>Reason discontinued:</em> {g.discontinuedReason}
            </p>
          )}
          <Html html={g.objectiveHtml} />
          <p>
            <em>Medical necessity (Pattern {g.rationalePattern}):</em>
          </p>
          <Html html={g.rationaleHtml} />
          {g.placeholders.length > 0 && (
            <div className="alert warn">
              Unresolved placeholders (fill before approval): {g.placeholders.join(", ")}
            </div>
          )}
          <Html html={g.graph} />
          {can(ctx.role, "data:enter") && (
            <details data-testid={`goal-data-${g.ordinal}`}>
              <summary>Data ({g.dataPoints.length} points)</summary>
              <RecordForm
                url={`/api/goals/${g.id}/data`}
                fields={[
                  { name: "date", label: "Date", type: "date" },
                  {
                    name: "value",
                    label:
                      g.measure === "percent"
                        ? "Percent correct"
                        : g.measure === "frequency"
                          ? "Count per session"
                          : "Minutes",
                    type: "number",
                  },
                  { name: "trials", label: "Trials", type: "number", optional: true },
                ]}
                submitLabel="Add data point"
                testId={`data-form-${g.ordinal}`}
              />
              <table>
                <tbody>
                  {[...g.dataPoints]
                    .reverse()
                    .slice(0, 10)
                    .map((p) => (
                      <tr key={p.id}>
                        <td>{toDay(p.date)}</td>
                        <td>
                          {Math.round(p.value * 10) / 10}
                          {measureUnit(g.measure)}
                          {p.trials ? ` (${p.trials} trials)` : ""}
                        </td>
                        <td>
                          <ActionButton
                            url={`/api/goals/${g.id}/data/${p.id}`}
                            method="DELETE"
                            secondary
                            confirm="Delete this data point?"
                          >
                            Delete
                          </ActionButton>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          )}
          <p className="muted">
            Data collection method: {g.dataCollection || "not set"} · Mastery: {g.masteryAccuracyPct}% across{" "}
            {g.masteryConsecutiveSessions} sessions with {g.masteryInstructors} people
          </p>
          <p className="muted" data-testid={`baseline-${g.ordinal}`}>
            Baseline:{" "}
            {g.baselineLockedAt && g.baselineValue !== null
              ? `${Math.round(g.baselineValue * 10) / 10}${measureUnit(g.measure)}, recorded ${toDay(g.baselineDate!)} and locked`
              : "not locked (the mean of the first three data points is used until it is locked)"}
          </p>
          {!g.baselineLockedAt && can(ctx.role, "goal:approve") && g.dataPoints.length >= 3 && (
            <ActionButton url={`/api/goals/${g.id}/baseline`} testId={`lock-baseline-${g.ordinal}`} secondary>
              Lock baseline from the first three data points
            </ActionButton>
          )}
          <GoalRecordEditor
            // Discontinue and Resume change the status from the menu: start over from the server's record.
            key={`${g.id}-${g.progressStatus}`}
            canWrite={can(ctx.role, "goal:write")}
            goal={{
              id: g.id,
              ordinal: g.ordinal,
              introducedAt: g.introducedAt ? toDay(g.introducedAt) : null,
              projectedMasteryDate: g.projectedMasteryDate ? toDay(g.projectedMasteryDate) : null,
              progressStatus: g.progressStatus,
              barriers: g.barriers,
              settings: (g.settings as string[] | null) ?? [],
            }}
          />
          {g.flat && <div className="alert warn">No improvement over the last 8 weeks.</div>}
          {g.flat && can(ctx.role, "goal:write") && (
            <FlatExplanation goalId={g.id} initial={g.flatExplanation} />
          )}
          {can(ctx.role, "goal:approve") && g.status !== "approved" && (
            <div className="row" style={{ marginTop: 8 }}>
              <ActionButton url={`/api/goals/${g.id}/approve`} testId={`approve-goal-${g.ordinal}`}>
                Approve goal
              </ActionButton>
            </div>
          )}
        </div>
      ))}

      {can(ctx.role, "goal:write") && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Goal library</h2>
          <details>
            <summary>Browse 18 domains × 3 tiers</summary>
            <ul>
              {v.templates.map((t) => (
                <li key={t.id} style={{ marginBottom: 6 }}>
                  <strong>
                    {t.domainNumber}. {t.domainName}: tier {t.tier} ({t.tierName})
                  </strong>{" "}
                  <ActionButton url={`/api/clients/${id}/goals`} body={{ templateId: t.id }} secondary>
                    Add
                  </ActionButton>
                  <div className="muted">{t.goalText}</div>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </>
  );
}
