"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";

export type PlanAssessmentOption = {
  id: string;
  typeName: string;
  administeredOn: string | null;
  status: "draft" | "confirmed";
  /** VB-MAPP administrations (verified) are always used. */
  vbmapp: boolean;
  selected: boolean;
};

/**
 * "Assessments used in this plan": a collapsed checklist. Each box saves on its own; there is
 * no select-all. A change flags the sections that use assessments for a redraft.
 */
export function PlanAssessments(props: {
  planId: string;
  clientId: string;
  options: PlanAssessmentOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState(
    () => new Set(props.options.filter((o) => o.selected && !o.vbmapp).map((o) => o.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const used = props.options.filter((o) => (o.vbmapp ? o.selected : chosen.has(o.id))).length;

  async function toggle(id: string, on: boolean) {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await send(`/api/plans/${props.planId}/assessments`, "PUT", { assessmentIds: [...next] });
    setBusy(false);
    if (!r.ok) {
      setChosen(chosen);
      return setError(String(r.data.error ?? "Request failed"));
    }
    const redraft = (r.data.redraft as string[] | undefined) ?? [];
    setNote(
      redraft.length
        ? `Saved. ${redraft.length === 1 ? "One section needs" : `${redraft.length} sections need`} a redraft.`
        : "Saved.",
    );
    router.refresh();
  }

  return (
    <details className="panel" data-testid="plan-assessments">
      <summary>
        Assessments used in this plan <span className="muted">({used})</span>
      </summary>
      {!props.options.length ? (
        <p className="muted">
          No assessments on record. <a href={`/clients/${props.clientId}/assessments`}>Add one</a>.
        </p>
      ) : (
        <div>
          {props.options.map((o) => {
            const id = `plan-assessment-${o.id}`;
            return (
              <div key={o.id} className="list-row" data-testid="plan-assessment">
                <label htmlFor={id} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={o.vbmapp ? o.selected : chosen.has(o.id)}
                    disabled={o.vbmapp || !props.canEdit || busy}
                    onChange={(e) => void toggle(o.id, e.target.checked)}
                  />
                  <span>
                    {o.typeName}
                    <span className="muted"> · {o.administeredOn ?? "no date"}</span>
                    {o.status === "draft" && (
                      <>
                        {" "}
                        <span className="badge draft">draft</span>
                      </>
                    )}
                    {o.vbmapp && (
                      <div className="muted">Verified VB-MAPP administrations are always used.</div>
                    )}
                    {!o.vbmapp && o.status === "draft" && chosen.has(o.id) && (
                      <div className="muted">Its scores are left out until a BCBA confirms it.</div>
                    )}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>
        Changing these flags the assessment sections for a redraft.{" "}
        <a href={`/clients/${props.clientId}/assessments`}>Assessments page</a>
      </p>
      {note && (
        <p className="muted" role="status" data-testid="plan-assessments-note">
          {note}
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </details>
  );
}
