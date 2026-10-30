"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Proposal, ProposedScore } from "@/lib/assessments/extract/match";
import { completeRows, customRowProblem, isBlankRow } from "@/lib/assessments/custom-row";
import { send } from "./actions";
import { RowMenu } from "./row-menu";

export type ReviewScale = {
  key: string;
  name: string;
  kind: string;
  kindLabel: string;
  parent: string | null;
  min: number;
  max: number;
};
type Option = { value: string; label: string };
type Row = { value: string; possible: string; reviewed: boolean };
type CustomRow = { name: string; kind: string; value: string; possible: string };

const FLAG_LABELS: Record<string, string> = {
  out_of_range: "out of range",
  over_possible: "more than possible",
  possible_missing: "possible not found",
  no_column_header: "no column heading",
  several_numbers: "several numbers on the line",
  ocr_unsure: "unclear in the image",
};
const CONFIDENCE: Record<ProposedScore["confidence"], { cls: string; label: string }> = {
  high: { cls: "ok", label: "high confidence" },
  medium: { cls: "warn", label: "medium confidence" },
  low: { cls: "danger", label: "low confidence" },
};
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** What is wrong with a row as typed now, if anything (shown live; the server checks again). */
function problem(s: ReviewScale, r: Row): string | null {
  if (r.value.trim() === "") return null;
  const v = Number(r.value);
  if (!Number.isFinite(v)) return "not a number";
  if (s.kind === "score_of_possible") {
    if (r.possible.trim() === "") return "enter the possible points";
    const p = Number(r.possible);
    if (!Number.isFinite(p) || p <= 0) return "possible must be more than 0";
    if (v < 0) return "below 0";
    if (v > p) return "more than possible";
    return null;
  }
  return v < s.min || v > s.max ? `out of range (${fmt(s.min)} to ${fmt(s.max)})` : null;
}

/**
 * The review screen for an imported score file. Every proposed number shows where it was found
 * and how sure the match is; scales not found stay blank. The BCBA checks each number (a box
 * per score: there is deliberately no "check all"), fills in the date and their initials, and
 * confirms. Editing a number counts as checking it.
 */
export function ImportReview(props: {
  importId: string;
  clientId: string;
  scales: ReviewScale[];
  proposal: Proposal;
  phiDetected: boolean;
  forms: Option[];
  respondents: Option[];
  customScales: boolean;
  kinds: Option[];
  canConfirm: boolean;
  canDiscard: boolean;
  today: string;
}) {
  const router = useRouter();
  const p = props.proposal;
  const proposed = new Map(p.scores.map((s) => [s.scaleKey, s]));
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(
      props.scales.map((s) => {
        const x = proposed.get(s.key);
        return [s.key, { value: str(x?.value), possible: str(x?.possible), reviewed: false }];
      }),
    ),
  );
  const [custom, setCustom] = useState<CustomRow[]>([]);
  const [head, setHead] = useState({
    administeredOn: p.administeredOn?.value ?? "",
    administeredBy: "",
    form: p.form?.key ?? "",
    respondent: p.respondent?.key ?? "",
    notes: "",
  });
  const [stripPhi, setStripPhi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edit = (key: string, patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [key]: { ...r[key]!, ...patch } }));
  const found = props.scales.filter((s) => proposed.has(s.key));
  const missing = props.scales.filter((s) => !proposed.has(s.key));
  const unchecked = props.scales.filter((s) => rows[s.key]!.value.trim() !== "" && !rows[s.key]!.reviewed);
  // Hand-added rows count only when complete; partly filled ones block until finished or removed.
  const unfinished = custom.filter((c) => customRowProblem(c) !== null).length;
  const entered =
    props.scales.filter((s) => rows[s.key]!.value.trim() !== "").length + completeRows(custom).length;
  const blockers = [
    unchecked.length > 0 && `${unchecked.length} score${unchecked.length === 1 ? "" : "s"} still to check`,
    unfinished > 0 && `${unfinished} added row${unfinished === 1 ? "" : "s"} to finish or remove`,
    !head.administeredOn && "the date administered",
    !head.administeredBy.trim() && "your initials",
    props.phiDetected && !stripPhi && "confirming that no name, birth date, or ID is imported",
    entered === 0 && "at least one score",
  ].filter(Boolean) as string[];

  async function confirm() {
    setBusy(true);
    setError(null);
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    const r = await send(`/api/assessments/imports/${props.importId}/confirm`, "POST", {
      stripPhi,
      administeredOn: head.administeredOn,
      administeredBy: head.administeredBy.trim(),
      form: head.form || null,
      respondent: head.respondent || null,
      notes: head.notes.trim() || null,
      scores: props.scales
        .filter((s) => rows[s.key]!.value.trim() !== "")
        .map((s) => ({
          scaleKey: s.key,
          value: num(rows[s.key]!.value),
          possible: num(rows[s.key]!.possible),
          reviewed: rows[s.key]!.reviewed,
        })),
      // Added by hand on this screen, so already checked by the person typing them.
      customScales: custom
        .filter((c) => !isBlankRow(c))
        .map((c) => ({
          name: c.name,
          kind: c.kind,
          value: num(c.value),
          possible: num(c.possible),
          reviewed: true,
        })),
    });
    setBusy(false);
    if (!r.ok)
      return setError(
        [
          String(r.data.error ?? "Could not confirm"),
          ...((r.data.issues as string[] | undefined) ?? []),
        ].join("\n"),
      );
    router.push(`/clients/${props.clientId}/assessments`);
    router.refresh();
  }

  const scaleRow = (s: ReviewScale) => {
    const row = rows[s.key]!;
    const x = proposed.get(s.key);
    const issue = problem(s, row);
    const changed = x && (row.value !== str(x.value) || row.possible !== str(x.possible));
    return (
      <div
        key={s.key}
        className="list-row"
        style={{ flexWrap: "wrap" }}
        data-testid="import-score"
        data-scale={s.key}
      >
        <div style={{ flex: "1 1 220px", minWidth: 0, paddingLeft: s.parent ? 16 : 0 }}>
          <strong>{s.name}</strong> <span className="muted">{s.kindLabel}</span>
          <div className="muted" data-testid="import-score-source">
            {x ? (
              <>
                Found at {x.location}
                {x.matchedLabel !== s.name && <> as “{x.matchedLabel}”</>}
                {changed && (
                  <>
                    {" "}
                    · file had {fmt(x.value)}
                    {x.possible !== null ? ` of ${fmt(x.possible)}` : ""}
                  </>
                )}
              </>
            ) : (
              "Not found in the file"
            )}
          </div>
          <div className="row" style={{ gap: 4, marginTop: 2 }}>
            {x && (
              <span className={`badge ${CONFIDENCE[x.confidence].cls}`}>
                {CONFIDENCE[x.confidence].label}
              </span>
            )}
            {x?.flags
              .filter((f) => !(f === "out_of_range" || f === "over_possible") || issue)
              .map((f) => (
                <span key={f} className="badge warn">
                  {FLAG_LABELS[f] ?? f.replace(/_/g, " ")}
                </span>
              ))}
            {issue && (
              <span className="badge danger" data-testid="import-score-problem">
                {issue}
              </span>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <input
            id={`import-${s.key}-value`}
            type="number"
            step="any"
            inputMode="decimal"
            aria-label={`${s.name} score`}
            style={{ width: 90 }}
            value={row.value}
            onChange={(e) => edit(s.key, { value: e.target.value, reviewed: e.target.value.trim() !== "" })}
          />
          {s.kind === "score_of_possible" && (
            <>
              <span className="muted">of</span>
              <input
                id={`import-${s.key}-possible`}
                type="number"
                step="any"
                inputMode="decimal"
                aria-label={`${s.name} possible`}
                style={{ width: 90 }}
                value={row.possible}
                onChange={(e) => edit(s.key, { possible: e.target.value, reviewed: row.value.trim() !== "" })}
              />
            </>
          )}
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontWeight: 400, margin: 0 }}>
            <input
              id={`import-${s.key}-checked`}
              type="checkbox"
              aria-label={`${s.name} checked against the file`}
              checked={row.reviewed}
              disabled={row.value.trim() === ""}
              onChange={(e) => edit(s.key, { reviewed: e.target.checked })}
            />
            Checked
          </label>
        </div>
      </div>
    );
  };

  return (
    <>
      {(p.flags.length > 0 || props.phiDetected) && (
        <div className="panel" data-testid="import-flags">
          <h2>Before you confirm</h2>
          {p.flags.map((f, i) => (
            <div key={i} className={`alert ${f.severity === "warn" ? "warn" : ""}`} data-testid="import-flag">
              {f.message}
              {f.locations.length > 0 && <div className="alert-source">At {f.locations.join(", ")}</div>}
            </div>
          ))}
          {props.phiDetected && (
            <label style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                data-testid="import-strip-phi"
                checked={stripPhi}
                onChange={(e) => setStripPhi(e.target.checked)}
              />{" "}
              I understand the name, birth date, or ID in this file is not imported (it was never stored)
            </label>
          )}
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Administration</h2>
          {props.canDiscard && (
            <RowMenu
              name="import"
              testId="import-menu"
              actions={[
                {
                  label: "Discard import",
                  request: {
                    url: `/api/assessments/imports/${props.importId}/discard`,
                    confirm: "Discard this import? Nothing from it is saved.",
                  },
                },
              ]}
            />
          )}
        </div>
        <div className="grid2">
          <div>
            <label htmlFor="import-administeredOn">Date administered</label>
            <input
              id="import-administeredOn"
              type="date"
              max={props.today}
              value={head.administeredOn}
              onChange={(e) => setHead({ ...head, administeredOn: e.target.value })}
            />
            <div className="muted">
              {p.administeredOn ? `Found at ${p.administeredOn.location}` : "Not found in the file"}
            </div>
          </div>
          <div>
            <label htmlFor="import-administeredBy">Administered by</label>
            <input
              id="import-administeredBy"
              placeholder="AS or BCBA-Q"
              value={head.administeredBy}
              onChange={(e) => setHead({ ...head, administeredBy: e.target.value })}
            />
            <div className="muted">Initials or a staff code, never a name</div>
          </div>
          {props.forms.length > 0 && (
            <div>
              <label htmlFor="import-form">Form</label>
              <select
                id="import-form"
                value={head.form}
                onChange={(e) => setHead({ ...head, form: e.target.value })}
              >
                <option value="">Choose…</option>
                {props.forms.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div className="muted">{p.form ? `Found at ${p.form.location}` : "Not found in the file"}</div>
            </div>
          )}
          {props.respondents.length > 0 && (
            <div>
              <label htmlFor="import-respondent">Respondent</label>
              <select
                id="import-respondent"
                value={head.respondent}
                onChange={(e) => setHead({ ...head, respondent: e.target.value })}
              >
                <option value="">Choose…</option>
                {props.respondents.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div className="muted">
                {p.respondent ? `Found at ${p.respondent.location}` : "Not found in the file"}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="panel" data-testid="import-scores">
        <h2>
          Scores{" "}
          <span className="muted">
            {found.length} of {props.scales.length} found
          </span>
        </h2>
        {found.length === 0 && <p className="muted">No scores were found. Enter them by hand below.</p>}
        {found.map(scaleRow)}
        {missing.length > 0 && (
          <details open={found.length === 0}>
            <summary className="muted">Not found in the file ({missing.length}): enter any by hand</summary>
            {missing.map(scaleRow)}
          </details>
        )}
        {props.customScales && (
          <div>
            <h3>Other areas or scales</h3>
            {custom.map((c, i) => {
              const set = (patch: Partial<CustomRow>) =>
                setCustom(custom.map((x, k) => (k === i ? { ...x, ...patch } : x)));
              const issue = customRowProblem(c);
              return (
                <div key={i} className="row" style={{ flexWrap: "wrap" }} data-testid="import-custom">
                  <input
                    aria-label="Name"
                    placeholder="Name"
                    value={c.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                  <select aria-label="Kind" value={c.kind} onChange={(e) => set({ kind: e.target.value })}>
                    <option value="">Kind…</option>
                    {props.kinds.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Score"
                    type="number"
                    step="any"
                    style={{ width: 90 }}
                    value={c.value}
                    onChange={(e) => set({ value: e.target.value })}
                  />
                  <input
                    aria-label="Possible"
                    type="number"
                    step="any"
                    style={{ width: 90 }}
                    placeholder="possible"
                    value={c.possible}
                    onChange={(e) => set({ possible: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Remove row"
                    onClick={() => setCustom(custom.filter((_, k) => k !== i))}
                  >
                    ×
                  </button>
                  {issue && (
                    <span className="badge danger" data-testid="import-custom-problem">
                      {issue}
                    </span>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              className="secondary small"
              onClick={() => setCustom([...custom, { name: "", kind: "", value: "", possible: "" }])}
            >
              Add area
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <label htmlFor="import-notes">Notes</label>
        <input
          id="import-notes"
          value={head.notes}
          placeholder="Optional. No names, birth dates, or IDs"
          onChange={(e) => setHead({ ...head, notes: e.target.value })}
        />
        {props.canConfirm ? (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                type="button"
                data-testid="confirm-assessment-import"
                disabled={busy || blockers.length > 0}
                onClick={confirm}
              >
                {busy ? "Saving…" : "Confirm scores"}
              </button>
              {blockers.length > 0 && (
                <span className="muted" data-testid="import-blockers">
                  Still needed: {blockers.join(", ")}
                </span>
              )}
            </div>
            <p className="muted">Confirmed scores are locked and can be cited in plans.</p>
          </>
        ) : (
          <p className="muted">A BCBA confirms imported scores.</p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </div>
    </>
  );
}
