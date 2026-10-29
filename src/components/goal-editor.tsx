"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";

export function GoalEditor({
  goal,
}: {
  goal: {
    id: string;
    objective: string;
    rationale: string;
    flatExplanation: string | null;
    masteryAccuracyPct: number;
    masteryConsecutiveSessions: number;
    masteryInstructors: number;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [g, setG] = useState(goal);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        Edit goal
      </button>
    );
  return (
    <div className="panel">
      <label>
        Objective (use {"{{goal.N.mastery_pct}}"}-style tokens for figures; brackets like [X] must be filled)
      </label>
      <textarea value={g.objective} onChange={(e) => setG({ ...g, objective: e.target.value })} />
      <label>Medical necessity rationale</label>
      <textarea value={g.rationale} onChange={(e) => setG({ ...g, rationale: e.target.value })} />
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
          onClick={async () => {
            const { id, flatExplanation, ...rest } = g;
            void flatExplanation;
            const r = await send(`/api/goals/${id}`, "PATCH", rest);
            if (!r.ok) return setError(String(r.data.error));
            setOpen(false);
            router.refresh();
          }}
        >
          Save (returns goal to draft)
        </button>
        <button className="secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
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
  const [msg, setMsg] = useState<string | null>(null);
  const dis = !canWrite;
  return (
    <div data-testid={`goal-record-${goal.ordinal}`}>
      <div className="row">
        <label>Status</label>
        <select
          disabled={dis}
          value={g.progressStatus}
          onChange={(e) => setG({ ...g, progressStatus: e.target.value })}
        >
          {STATUSES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
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
        value={g.settings.join(", ")}
        placeholder="home, clinic"
        onChange={(e) =>
          setG({
            ...g,
            settings: e.target.value
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          })
        }
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
            const changed = Object.fromEntries(
              (Object.keys(g) as (keyof typeof g)[])
                .filter(
                  (k) => k !== "id" && k !== "ordinal" && JSON.stringify(g[k]) !== JSON.stringify(goal[k]),
                )
                .map((k) => [k, g[k]]),
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
