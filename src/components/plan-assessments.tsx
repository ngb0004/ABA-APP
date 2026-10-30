"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";
import { resetConfirmText, type PlanAssessmentOption } from "./plan-assessments-reset";

export type { PlanAssessmentOption };

/**
 * "Assessments used in this plan": a collapsed checklist. Each box saves on its own; there is
 * no select-all. A change flags the sections that use assessments for a redraft.
 */
export function PlanAssessments(props: {
  planId: string;
  clientId: string;
  options: PlanAssessmentOption[];
  canEdit: boolean;
  /** Where the default selection comes from: "Default window: 6 months", or a payor rule's. */
  windowLabel: string;
  /** The plan's creation date, which the default window counts back from. */
  createdOn: string;
}) {
  const router = useRouter();
  const stored = props.options.filter((o) => o.selected && !o.vbmapp).map((o) => o.id);
  const [chosen, setChosen] = useState(() => new Set(stored));
  // Follow the stored selection when the page reloads it (after "Reset to default").
  const storedKey = stored.join(",");
  const [seen, setSeen] = useState(storedKey);
  if (seen !== storedKey) {
    setSeen(storedKey);
    setChosen(new Set(stored));
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const differs = props.options.some((o) => !o.vbmapp && chosen.has(o.id) !== o.byDefault);
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
    savedNote(r.data.redraft as string[] | undefined);
  }

  function savedNote(redraft: string[] = []) {
    setNote(
      redraft.length
        ? `Saved. ${redraft.length === 1 ? "One section needs" : `${redraft.length} sections need`} a redraft.`
        : "Saved.",
    );
    router.refresh();
  }

  async function reset() {
    const text = resetConfirmText(props.options, chosen);
    if (text === null) {
      setError(null);
      setNote("Already the default selection.");
      return;
    }
    if (!window.confirm(text)) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await send(`/api/plans/${props.planId}/assessments/default`, "POST", {});
    setBusy(false);
    if (!r.ok) return setError(String(r.data.error ?? "Request failed"));
    if (r.data.changed === false) {
      setNote("Already the default selection.");
      return;
    }
    // The page reloads the selection; the boxes follow it.
    savedNote(r.data.redraft as string[] | undefined);
  }

  return (
    <details className="panel" data-testid="plan-assessments">
      <summary>
        Assessments used in this plan <span className="muted">({used})</span>
      </summary>
      <p className="muted" data-testid="plan-assessments-window">
        {props.windowLabel}. Reset to default checks the confirmed assessments given in this window before the
        plan was created ({props.createdOn}) and unchecks the rest; choose others as needed.
      </p>
      {differs && (
        <p className="muted" data-testid="plan-assessments-differs">
          This plan&apos;s selection differs from that default (chosen by hand, or set under an earlier
          window).
        </p>
      )}
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
      {props.canEdit && props.options.length > 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn dark"
            data-testid="plan-assessments-reset"
            disabled={busy}
            onClick={() => void reset()}
          >
            Reset to default
          </button>
        </div>
      )}
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
