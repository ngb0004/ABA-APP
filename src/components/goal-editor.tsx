"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { AutosaveState } from "@/lib/goals/autosave";
import { saveStatusText } from "@/lib/goals/save-status";
import { send } from "./actions";
import { flushGoal, forgetGoal, goalShownValues, goalVersionChanged, useGoalAutosave } from "./goal-autosave";
import { RowMenu } from "./row-menu";

type EditableGoal = {
  id: string;
  /** The goal's version: autosaves are refused if it changed elsewhere. */
  updatedAt: string;
  objective: string;
  rationale: string;
  masteryAccuracyPct: number;
  masteryConsecutiveSessions: number;
  masteryInstructors: number;
};

/** The fields of each editor (they share one queue per goal; each shows only its own status). */
const DIALOG_FIELDS = [
  "objective",
  "rationale",
  "masteryAccuracyPct",
  "masteryConsecutiveSessions",
  "masteryInstructors",
] as const;
const RECORD_FIELDS = [
  "introducedAt",
  "projectedMasteryDate",
  "progressStatus",
  "barriers",
  "settings",
] as const;
const FLAT_FIELDS = ["flatExplanation"] as const;

/**
 * "Saving…", "Saved", or why not, next to an autosaving editor: for its own fields, and naming a
 * field shown elsewhere (with where to fix it) that is not saved.
 */
export function SaveStatus({
  state,
  fields,
  testId,
}: {
  state: AutosaveState;
  fields: readonly string[];
  testId?: string;
}) {
  const { text, bad } = saveStatusText(state, fields);
  return (
    <span role="status" aria-live="polite" className={bad ? "error" : "muted"} data-testid={testId}>
      {text}
    </span>
  );
}

const shownValue = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "(empty)"
    : Array.isArray(v)
      ? v.join(", ") || "(empty)"
      : String(v);

/**
 * The problem with one field: a value that would be refused, the server's reason a save failed,
 * or a change made somewhere else while it was edited here (with the choice of which to keep).
 */
function FieldProblem({
  field,
  state,
  resolve,
}: {
  field: string;
  state: AutosaveState;
  resolve?: (field: string, keep: "mine" | "theirs") => void;
}) {
  if (Object.hasOwn(state.conflicts, field))
    return (
      <div className="alert warn" role="alert" data-testid={`conflict-${field}`}>
        <div>
          This was changed somewhere else while you were editing it. Your text is kept above. The other
          version:
        </div>
        <blockquote style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
          {shownValue(state.conflicts[field])}
        </blockquote>
        {state.problems[field] && <div className="error">{state.problems[field]}</div>}
        {resolve && (
          <div className="row" style={{ marginTop: 6 }}>
            <button type="button" onClick={() => resolve(field, "mine")}>
              Keep mine
            </button>
            <button type="button" className="secondary" onClick={() => resolve(field, "theirs")}>
              Use the other version
            </button>
          </div>
        )}
      </div>
    );
  const problem = state.problems[field] ?? (state.failedFields.includes(field) ? state.error : null);
  if (!problem) return null;
  return (
    <div className="error" role="alert" data-testid={`problem-${field}`}>
      {problem}
    </div>
  );
}

/** A number input's value: "" while the box is empty. */
const shownNumber = (n: number) => (Number.isFinite(n) ? String(n) : "");
const parsedNumber = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

/**
 * The goal's wording and mastery criteria, edited in the goal menu's dialog. Saves as you type
 * (about a second after you stop, and when you leave a field); there is no Save button.
 */
export function GoalEditor({ goal, onDone }: { goal: EditableGoal; onDone: () => void }) {
  const { id, updatedAt, ...fields } = goal;
  const { values: g, set, state, flush, resolve } = useGoalAutosave(id, updatedAt, fields);
  const blur = () => void flush();
  const [stuck, setStuck] = useState(false);
  return (
    <div>
      <label htmlFor={`objective-${id}`}>
        Objective (use {"{{goal.N.mastery_pct}}"}-style tokens for figures; brackets like [X] must be filled)
      </label>
      <textarea
        id={`objective-${id}`}
        value={g.objective}
        onChange={(e) => set("objective", e.target.value)}
        onBlur={blur}
      />
      <FieldProblem field="objective" state={state} resolve={resolve} />
      <label htmlFor={`rationale-${id}`}>Medical necessity rationale</label>
      <textarea
        id={`rationale-${id}`}
        value={g.rationale}
        onChange={(e) => set("rationale", e.target.value)}
        onBlur={blur}
      />
      <FieldProblem field="rationale" state={state} resolve={resolve} />
      <div className="row">
        <label htmlFor={`mastery-pct-${id}`}>Mastery %</label>
        <input
          id={`mastery-pct-${id}`}
          type="number"
          value={shownNumber(g.masteryAccuracyPct)}
          min={1}
          max={100}
          onChange={(e) => set("masteryAccuracyPct", parsedNumber(e.target.value))}
          onBlur={blur}
          style={{ width: 80 }}
        />
        <label htmlFor={`mastery-sessions-${id}`}>Consecutive sessions</label>
        <input
          id={`mastery-sessions-${id}`}
          type="number"
          value={shownNumber(g.masteryConsecutiveSessions)}
          min={1}
          onChange={(e) => set("masteryConsecutiveSessions", parsedNumber(e.target.value))}
          onBlur={blur}
          style={{ width: 80 }}
        />
        <label htmlFor={`mastery-people-${id}`}>Instructors</label>
        <input
          id={`mastery-people-${id}`}
          type="number"
          value={shownNumber(g.masteryInstructors)}
          min={1}
          onChange={(e) => set("masteryInstructors", parsedNumber(e.target.value))}
          onBlur={blur}
          style={{ width: 80 }}
        />
      </div>
      <FieldProblem field="masteryAccuracyPct" state={state} resolve={resolve} />
      <FieldProblem field="masteryConsecutiveSessions" state={state} resolve={resolve} />
      <FieldProblem field="masteryInstructors" state={state} resolve={resolve} />
      <p className="muted" style={{ marginBottom: 0 }}>
        Changes save as you type. Changing an approved goal returns it to draft for approval.
      </p>
      <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
        <button
          className="secondary"
          onClick={async () => {
            // Something typed here is not saved (held back, failed, or in conflict): stay open.
            if (await flush()) return onDone();
            setStuck(true);
          }}
        >
          Done
        </button>
        <SaveStatus state={state} fields={DIALOG_FIELDS} testId={`goal-save-status-${id}`} />
      </div>
      {stuck && saveStatusText(state, DIALOG_FIELDS).bad && (
        <p className="error" role="alert" style={{ marginBottom: 0 }}>
          Not everything here is saved yet. Fix the highlighted field (or choose a version) before closing;
          closing now keeps your text unsaved.
        </p>
      )}
    </div>
  );
}

const DISCONTINUE_REASON_MAX = 500;

/**
 * Discontinue a goal with history: the reason and date go on the record; its data and graph stay.
 * "Today" is the server's (asOf), the same day the server checks the date against.
 */
function DiscontinueForm({ goalId, asOf, onDone }: { goalId: string; asOf: string; onDone: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(asOf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      data-testid={`discontinue-form-${goalId}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        // Whatever was typed into the goal is saved first.
        const notSaved = await flushGoal(goalId);
        if (notSaved) {
          setBusy(false);
          return setError(notSaved);
        }
        const r = await send(`/api/goals/${goalId}/discontinue`, "POST", { reason, date });
        setBusy(false);
        if (r.ok) goalVersionChanged(goalId, r.data.updatedAt);
        if (!r.ok)
          return setError(
            [
              String(r.data.error ?? "Could not save"),
              ...((r.data.issues as string[] | undefined) ?? []),
            ].join("\n"),
          );
        onDone();
        router.refresh();
      }}
    >
      <p className="muted" style={{ marginTop: 0 }}>
        The goal, its data, and its graph stay in the record and in progress reporting, marked discontinued.
      </p>
      <label htmlFor={`discontinue-reason-${goalId}`}>Reason (shown with the goal in progress reports)</label>
      <textarea
        id={`discontinue-reason-${goalId}`}
        required
        maxLength={DISCONTINUE_REASON_MAX}
        style={{ minHeight: 70, fontFamily: "inherit" }}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <label htmlFor={`discontinue-date-${goalId}`}>Date discontinued</label>
      <input
        id={`discontinue-date-${goalId}`}
        type="date"
        required
        max={asOf}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button type="submit" disabled={busy || !reason.trim() || !date}>
          {busy ? "Saving…" : "Discontinue goal"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="error" role="alert" style={{ whiteSpace: "pre-line" }}>
          {error}
        </div>
      )}
    </form>
  );
}

function ResumeConfirm({ goalId, onDone }: { goalId: string; onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <p style={{ marginTop: 0 }}>
        The goal goes back to in progress. The date and reason discontinued are cleared; the audit log keeps
        them.
      </p>
      <div className="row">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const notSaved = await flushGoal(goalId);
            if (notSaved) {
              setBusy(false);
              return setError(notSaved);
            }
            const r = await send(`/api/goals/${goalId}/resume`, "POST", {});
            setBusy(false);
            if (!r.ok) return setError(String(r.data.error ?? "Could not resume the goal"));
            goalVersionChanged(goalId, r.data.updatedAt);
            onDone();
            router.refresh();
          }}
        >
          Resume goal
        </button>
        <button className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Why a goal cannot be removed, with the way forward the server gave. */
function RemoveBlocked({ reason, onDone }: { reason: string; onDone: () => void }) {
  return (
    <div>
      <p style={{ marginTop: 0 }}>{reason}</p>
      <div className="row">
        <button className="secondary" onClick={onDone}>
          OK
        </button>
      </div>
    </div>
  );
}

/**
 * The one "⋯" menu on a goal card: Edit goal, Discontinue… or Resume, and Remove. Remove deletes
 * only when the server's rule allows it (a goal added by mistake, with no data and never approved);
 * otherwise "Remove…" explains why not. Each action saves what was typed into the goal first.
 */
export function GoalMenu({
  goal,
  asOf,
  canRemove,
  removeBlocker,
}: {
  /** name: how readers know the goal ("Manding goal"); goals are never numbered. */
  goal: EditableGoal & { ordinal: number; name: string; progressStatus: string };
  /** The server's today (YYYY-MM-DD). */
  asOf: string;
  /** The user may remove goals. */
  canRemove: boolean;
  removeBlocker: string | null;
}) {
  const { ordinal, progressStatus, name, ...editable } = goal;
  const discontinued = progressStatus === "discontinued";
  return (
    <RowMenu
      name={name}
      testId={`goal-menu-${ordinal}`}
      actions={[
        {
          label: "Edit goal",
          title: `Edit ${name}`,
          content: (close) => <GoalEditor goal={editable} onDone={close} />,
        },
        discontinued
          ? {
              label: "Resume",
              title: `Resume ${name}?`,
              content: (close) => <ResumeConfirm goalId={goal.id} onDone={close} />,
            }
          : {
              label: "Discontinue…",
              title: `Discontinue ${name}`,
              content: (close) => <DiscontinueForm goalId={goal.id} asOf={asOf} onDone={close} />,
            },
        ...(canRemove && removeBlocker
          ? [
              {
                label: "Remove…",
                title: `${name} can't be removed`,
                content: (close: () => void) => <RemoveBlocked reason={removeBlocker} onDone={close} />,
              },
            ]
          : []),
      ]}
      remove={
        canRemove && !removeBlocker
          ? {
              url: `/api/goals/${goal.id}`,
              label: "Remove",
              confirm: "Remove this goal? It was added by mistake and has no data.",
              // Saved first, in case the server refuses the removal; dropped once it is gone.
              before: () => flushGoal(goal.id),
              after: () => forgetGoal(goal.id),
            }
          : undefined
      }
    />
  );
}

/** An action on the goal (Approve, Lock baseline) that first saves anything typed into it. */
export function GoalActionButton({
  goalId,
  url,
  testId,
  secondary,
  expected,
  children,
}: {
  goalId: string;
  url: string;
  /** For Approve: what the page shows of the goal (its wording, mastery criteria, and dates). */
  expected?: Record<string, unknown>;
  testId?: string;
  secondary?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        data-testid={testId}
        className={secondary ? "secondary" : undefined}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const notSaved = await flushGoal(goalId);
          if (notSaved) {
            setBusy(false);
            return setError(notSaved);
          }
          // Approve names what the approver was shown; a goal changed since is refused.
          const r = await send(url, "POST", expected ? { expected: goalShownValues(goalId, expected) } : {});
          setBusy(false);
          if (!r.ok) {
            setError(String(r.data.error ?? "Request failed"));
            // The goal changed since the page showed it: show the latest.
            if (r.status === 409) router.refresh();
            return;
          }
          goalVersionChanged(goalId, r.data.updatedAt);
          router.refresh();
        }}
      >
        {busy ? "Working…" : children}
      </button>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </span>
  );
}

/** The BCBA's explanation of flat progress; saves as you type. */
export function FlatExplanation({
  goalId,
  updatedAt,
  initial,
}: {
  goalId: string;
  updatedAt: string;
  initial: string | null;
}) {
  const { values, set, state, flush, resolve } = useGoalAutosave(goalId, updatedAt, {
    flatExplanation: initial,
  });
  return (
    <div>
      <label htmlFor={`flat-explanation-${goalId}`}>
        Flat progress: BCBA explanation (required before export)
      </label>
      <textarea
        id={`flat-explanation-${goalId}`}
        data-testid={`flat-explanation-${goalId}`}
        style={{ minHeight: 60, fontFamily: "inherit" }}
        value={values.flatExplanation ?? ""}
        onChange={(e) =>
          set("flatExplanation", e.target.value, e.target.value.trim() ? e.target.value : null)
        }
        onBlur={() => void flush()}
      />
      <FieldProblem field="flatExplanation" state={state} resolve={resolve} />
      <SaveStatus state={state} fields={FLAT_FIELDS} testId={`flat-save-status-${goalId}`} />
    </div>
  );
}

const STATUSES = [
  ["new", "New"],
  ["in_progress", "In progress"],
  ["mastered", "Mastered"],
  ["on_hold", "On hold"],
  ["discontinued", "Discontinued"],
] as const;

const splitSettings = (t: string) =>
  t
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Dates, status, barriers, and settings: the parts of a goal record payors ask for besides the
 * goal itself. Saves as you type; Discontinue and Resume (in the goal's menu) keep what is here.
 */
export function GoalRecordEditor({
  goal,
  canWrite,
}: {
  goal: {
    id: string;
    ordinal: number;
    updatedAt: string;
    introducedAt: string | null;
    projectedMasteryDate: string | null;
    progressStatus: string;
    barriers: string;
    settings: string[];
  };
  canWrite: boolean;
}) {
  const { id, ordinal, updatedAt, ...fields } = goal;
  const { values: g, set, state, flush, revision, resolve } = useGoalAutosave(id, updatedAt, fields);
  // Raw text while typing, so commas and spaces survive; saved as a list.
  const [settingsText, setSettingsText] = useState(g.settings.join(", "));
  useEffect(() => {
    if (revision) setSettingsText(g.settings.join(", "));
    // Only when a newer record came from the server, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  const dis = !canWrite;
  const blur = () => void flush();
  const datesNote = "Changing dates returns an approved goal to draft.";
  return (
    <div data-testid={`goal-record-${ordinal}`}>
      <div className="row">
        <label htmlFor={`status-${id}`}>Status</label>
        {/* Discontinuing needs a reason and date, so it lives in the goal's menu (as does Resume). */}
        <select
          id={`status-${id}`}
          disabled={dis || goal.progressStatus === "discontinued" || g.progressStatus === "discontinued"}
          value={g.progressStatus}
          title={g.progressStatus === "discontinued" ? "Use Resume in the goal's menu" : undefined}
          onChange={(e) => {
            set("progressStatus", e.target.value);
            void flush();
          }}
        >
          {STATUSES.filter(([v]) => v !== "discontinued" || g.progressStatus === "discontinued").map(
            ([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ),
          )}
        </select>
        <label htmlFor={`introduced-${id}`}>Introduced</label>
        <input
          id={`introduced-${id}`}
          type="date"
          disabled={dis}
          title={datesNote}
          value={g.introducedAt ?? ""}
          onChange={(e) => set("introducedAt", e.target.value || null)}
          onBlur={blur}
        />
        <label htmlFor={`projected-${id}`}>Projected mastery</label>
        <input
          id={`projected-${id}`}
          type="date"
          disabled={dis}
          title={datesNote}
          value={g.projectedMasteryDate ?? ""}
          onChange={(e) => set("projectedMasteryDate", e.target.value || null)}
          onBlur={blur}
        />
      </div>
      <FieldProblem field="progressStatus" state={state} resolve={resolve} />
      <FieldProblem field="introducedAt" state={state} resolve={resolve} />
      <FieldProblem field="projectedMasteryDate" state={state} resolve={resolve} />
      <label htmlFor={`settings-${id}`}>Settings (comma separated)</label>
      <input
        id={`settings-${id}`}
        disabled={dis}
        value={settingsText}
        placeholder="home, clinic"
        onChange={(e) => {
          setSettingsText(e.target.value);
          set("settings", splitSettings(e.target.value));
        }}
        onBlur={blur}
      />
      <FieldProblem field="settings" state={state} resolve={resolve} />
      <label htmlFor={`barriers-${id}`}>Barriers to progress and actions taken</label>
      <textarea
        id={`barriers-${id}`}
        data-testid={`goal-barriers-${ordinal}`}
        disabled={dis}
        style={{ minHeight: 50, fontFamily: "inherit" }}
        value={g.barriers}
        onChange={(e) => set("barriers", e.target.value)}
        onBlur={blur}
      />
      <FieldProblem field="barriers" state={state} resolve={resolve} />
      {canWrite && (
        <SaveStatus state={state} fields={RECORD_FIELDS} testId={`goal-record-status-${ordinal}`} />
      )}
    </div>
  );
}
