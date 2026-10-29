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
