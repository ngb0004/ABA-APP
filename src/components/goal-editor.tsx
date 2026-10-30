"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";
import { RowMenu } from "./row-menu";

type EditableGoal = {
  id: string;
  objective: string;
  rationale: string;
  masteryAccuracyPct: number;
  masteryConsecutiveSessions: number;
  masteryInstructors: number;
};

/** The goal's wording and mastery criteria, edited in the goal menu's dialog. */
export function GoalEditor({ goal, onDone }: { goal: EditableGoal; onDone: () => void }) {
  const router = useRouter();
  const [g, setG] = useState(goal);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <label htmlFor={`objective-${goal.id}`}>
        Objective (use {"{{goal.N.mastery_pct}}"}-style tokens for figures; brackets like [X] must be filled)
      </label>
      <textarea
        id={`objective-${goal.id}`}
        value={g.objective}
        onChange={(e) => setG({ ...g, objective: e.target.value })}
      />
      <label htmlFor={`rationale-${goal.id}`}>Medical necessity rationale</label>
      <textarea
        id={`rationale-${goal.id}`}
        value={g.rationale}
        onChange={(e) => setG({ ...g, rationale: e.target.value })}
      />
      <div className="row">
        <label>Mastery %</label>
        <input
          type="number"
          value={g.masteryAccuracyPct}
          min={1}
          max={100}
          onChange={(e) => setG({ ...g, masteryAccuracyPct: Number(e.target.value) })}
          style={{ width: 80 }}
        />
        <label>Consecutive sessions</label>
        <input
          type="number"
          value={g.masteryConsecutiveSessions}
          min={1}
          onChange={(e) => setG({ ...g, masteryConsecutiveSessions: Number(e.target.value) })}
          style={{ width: 80 }}
        />
        <label>Instructors</label>
        <input
          type="number"
          value={g.masteryInstructors}
          min={1}
          onChange={(e) => setG({ ...g, masteryInstructors: Number(e.target.value) })}
          style={{ width: 80 }}
        />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          disabled={busy}
          onClick={async () => {
            const { id, ...rest } = g;
            setBusy(true);
            const r = await send(`/api/goals/${id}`, "PATCH", rest);
            setBusy(false);
            if (!r.ok) return setError(String(r.data.error));
            onDone();
            router.refresh();
          }}
        >
          Save (returns goal to draft)
        </button>
        <button className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
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
        const r = await send(`/api/goals/${goalId}/discontinue`, "POST", { reason, date });
        setBusy(false);
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
            const r = await send(`/api/goals/${goalId}/resume`, "POST", {});
            setBusy(false);
            if (!r.ok) return setError(String(r.data.error ?? "Could not resume the goal"));
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
 * otherwise "Remove…" explains why not.
 */
export function GoalMenu({
  goal,
  asOf,
  canRemove,
  removeBlocker,
}: {
  goal: EditableGoal & { ordinal: number; progressStatus: string };
  /** The server's today (YYYY-MM-DD). */
  asOf: string;
  /** The user may remove goals. */
  canRemove: boolean;
  removeBlocker: string | null;
}) {
  const name = `Goal ${goal.ordinal}`;
  const { ordinal, progressStatus, ...editable } = goal;
  void ordinal;
  const discontinued = progressStatus === "discontinued";
  return (
    <RowMenu
      name={name}
      testId={`goal-menu-${goal.ordinal}`}
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
            }
          : undefined
      }
    />
  );
}

export function FlatExplanation({ goalId, initial }: { goalId: string; initial: string | null }) {
  const router = useRouter();
  const [text, setText] = useState(initial ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <label>Flat progress: BCBA explanation (required before export)</label>
      <textarea
        data-testid={`flat-explanation-${goalId}`}
        style={{ minHeight: 60, fontFamily: "inherit" }}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        onClick={async () => {
          const r = await send(`/api/goals/${goalId}`, "PATCH", { flatExplanation: text.trim() || null });
          setMsg(r.ok ? "Saved" : String(r.data.error));
          router.refresh();
        }}
      >
        Save explanation
      </button>
      {msg && <span className="muted"> {msg}</span>}
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

/** Dates, status, barriers, and settings: the parts of a goal record payors ask for besides the goal itself. */
export function GoalRecordEditor({
  goal,
  canWrite,
}: {
  goal: {
    id: string;
    ordinal: number;
    introducedAt: string | null;
    projectedMasteryDate: string | null;
    progressStatus: string;
    barriers: string;
    settings: string[];
  };
  canWrite: boolean;
}) {
  const router = useRouter();
  const [g, setG] = useState(goal);
  // Raw text while typing, so commas survive; split into settings on blur and save.
  const [settingsText, setSettingsText] = useState(goal.settings.join(", "));
  const splitSettings = (t: string) =>
    t
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const [msg, setMsg] = useState<string | null>(null);
  const dis = !canWrite;
  return (
    <div data-testid={`goal-record-${goal.ordinal}`}>
      <div className="row">
        <label>Status</label>
        {/* Discontinuing needs a reason and date, so it lives in the goal's menu (as does Resume). */}
        <select
          disabled={dis || goal.progressStatus === "discontinued"}
          value={g.progressStatus}
          title={goal.progressStatus === "discontinued" ? "Use Resume in the goal's menu" : undefined}
          onChange={(e) => setG({ ...g, progressStatus: e.target.value })}
        >
          {STATUSES.filter(([v]) => v !== "discontinued" || goal.progressStatus === "discontinued").map(
            ([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ),
          )}
        </select>
        <label>Introduced</label>
        <input
          type="date"
          disabled={dis}
          value={g.introducedAt ?? ""}
          onChange={(e) => setG({ ...g, introducedAt: e.target.value || null })}
        />
        <label>Projected mastery</label>
        <input
          type="date"
          disabled={dis}
          value={g.projectedMasteryDate ?? ""}
          onChange={(e) => setG({ ...g, projectedMasteryDate: e.target.value || null })}
        />
      </div>
      <label>Settings (comma separated)</label>
      <input
        disabled={dis}
        value={settingsText}
        placeholder="home, clinic"
        onChange={(e) => setSettingsText(e.target.value)}
        onBlur={() => setG({ ...g, settings: splitSettings(settingsText) })}
      />
      <label>Barriers to progress and actions taken</label>
      <textarea
        disabled={dis}
        style={{ minHeight: 50, fontFamily: "inherit" }}
        value={g.barriers}
        onChange={(e) => setG({ ...g, barriers: e.target.value })}
      />
      {canWrite && (
        <button
          className="secondary"
          data-testid={`save-goal-record-${goal.ordinal}`}
          onClick={async () => {
            const current = { ...g, settings: splitSettings(settingsText) };
            const changed = Object.fromEntries(
              (Object.keys(current) as (keyof typeof current)[])
                .filter(
                  (k) =>
                    k !== "id" && k !== "ordinal" && JSON.stringify(current[k]) !== JSON.stringify(goal[k]),
                )
                .map((k) => [k, current[k]]),
            );
            if (!Object.keys(changed).length) return setMsg("No changes");
            const r = await send(`/api/goals/${goal.id}`, "PATCH", changed);
            setMsg(
              r.ok
                ? "introducedAt" in changed || "projectedMasteryDate" in changed
                  ? "Saved. Changing dates returns the goal to draft."
                  : "Saved"
                : String(r.data.error),
            );
            router.refresh();
          }}
        >
          Save goal record
        </button>
      )}
      {msg && <span className="muted"> {msg}</span>}
    </div>
  );
}
