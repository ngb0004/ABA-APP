"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BLOCKS, DAYS, type IntakeAnswers, type IntakeField } from "@/lib/intake/schema";
import { send } from "./actions";

type Answer = Record<string, unknown>;

export function IntakeForm({
  clientId,
  fields,
  initial,
  canSubmit,
}: {
  clientId: string;
  fields: IntakeField[];
  initial: IntakeAnswers;
  canSubmit: boolean;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, Answer>>(initial as Record<string, Answer>);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (id: string, a: Answer | undefined) =>
    setAnswers((prev) => {
      const next = { ...prev };
      if (a === undefined) delete next[id];
      else next[id] = a;
      return next;
    });
  const groups = [...new Set(fields.map((f) => f.group))];

  async function save(submit: boolean) {
    setMsg(null);
    const r = await send(`/api/clients/${clientId}/intake`, "PUT", { answers, submit });
    setMsg({ ok: r.ok, text: r.ok ? (submit ? "Intake submitted." : "Draft saved.") : String(r.data.error) });
    if (r.ok) router.refresh();
  }

  return (
    <div>
      {groups.map((g) => (
        <div className="panel" key={g}>
          <h2 style={{ marginTop: 0 }}>{g}</h2>
          {fields
            .filter((f) => f.group === g)
            .map((f) => {
              const a = answers[f.id];
              const na = a?.na === true;
              return (
                <div
                  key={f.id}
                  style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}
                  data-field={f.id}
                >
                  <label>
                    {f.label}{" "}
                    {f.sensitivity === "restricted" && (
                      <span className="badge danger">restricted: BCBA only, never sent to AI</span>
                    )}
                    {f.safetyFlag && (
                      <span className="badge warn" style={{ marginLeft: 4 }}>
                        safety
                      </span>
                    )}
                  </label>
                  <div className="row">
                    <label style={{ fontWeight: 400, margin: 0 }}>
                      <input
                        type="checkbox"
                        checked={na}
                        onChange={(e) => set(f.id, e.target.checked ? { na: true } : undefined)}
                      />{" "}
                      None / not applicable
                    </label>
                  </div>
                  {!na && <FieldInput field={f} answer={a} onChange={(v) => set(f.id, v)} />}
                </div>
              );
            })}
        </div>
      ))}
      <div className="row">
        <button className="secondary" onClick={() => save(false)}>
          Save draft
        </button>
        {canSubmit && <button onClick={() => save(true)}>Submit intake</button>}
      </div>
      {msg && (
        <div className={msg.ok ? "alert info" : "error"} role="status">
          {msg.text}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  field,
  answer,
  onChange,
}: {
  field: IntakeField;
  answer: Answer | undefined;
  onChange: (a: Answer | undefined) => void;
}) {
  const value = answer?.value as unknown;
  const comment = (answer?.comment as string | undefined) ?? "";
  const withComment = (v: unknown) =>
    onChange(v === undefined || v === "" ? undefined : { value: v, ...(comment ? { comment } : {}) });
  const commentBox = [
    "yes_no",
    "likert",
    "intensity",
    "checklist",
    "select",
    "frequency_duration",
    "date",
  ].includes(field.type) && (
    <input
      placeholder="Comment (optional)"
      value={comment}
      onChange={(e) =>
        answer?.value !== undefined &&
        onChange({ value: answer.value, ...(e.target.value ? { comment: e.target.value } : {}) })
      }
      style={{ width: "100%", marginTop: 4 }}
    />
  );
  switch (field.type) {
    case "yes_no":
      return (
        <div>
          <div className="row">
            {[true, false].map((v) => (
              <label key={String(v)} style={{ fontWeight: 400, margin: 0 }}>
                <input type="radio" name={field.id} checked={value === v} onChange={() => withComment(v)} />{" "}
                {v ? "Yes" : "No"}
              </label>
            ))}
          </div>
          {commentBox}
        </div>
      );
    case "likert":
    case "intensity":
    case "select":
      return (
        <div>
          <select value={(value as string) ?? ""} onChange={(e) => withComment(e.target.value)}>
            <option value="">Choose…</option>
            {field.options!.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {commentBox}
        </div>
      );
    case "checklist": {
      const arr = (value as string[] | undefined) ?? [];
      return (
        <div>
          <div className="row">
            {field.options!.map((o) => (
              <label key={o} style={{ fontWeight: 400, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={arr.includes(o)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...arr, o] : arr.filter((x) => x !== o);
                    withComment(next.length ? next : undefined);
                  }}
                />{" "}
                {o}
              </label>
            ))}
          </div>
          {commentBox}
        </div>
      );
    }
    case "date":
      return (
        <div>
          <input type="date" value={(value as string) ?? ""} onChange={(e) => withComment(e.target.value)} />
          {commentBox}
        </div>
      );
    case "text":
      return (
        <textarea
          style={{ minHeight: 60, fontFamily: "inherit" }}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value ? { value: e.target.value } : undefined)}
        />
      );
    case "frequency_duration": {
      const v = (value as { count: number; per: string; durationMinutes: number } | undefined) ?? {
        count: 0,
        per: "day",
        durationMinutes: 0,
      };
      const upd = (p: Partial<typeof v>) => withComment({ ...v, ...p });
      return (
        <div className="row">
          <input
            type="number"
            min={0}
            style={{ width: 80 }}
            value={v.count}
            onChange={(e) => upd({ count: Number(e.target.value) })}
          />{" "}
          times per
          <select value={v.per} onChange={(e) => upd({ per: e.target.value })}>
            {["day", "week", "month"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          lasting{" "}
          <input
            type="number"
            min={0}
            style={{ width: 80 }}
            value={v.durationMinutes}
            onChange={(e) => upd({ durationMinutes: Number(e.target.value) })}
          />{" "}
          minutes
          {commentBox}
        </div>
      );
    }
    case "medication_table":
    case "prior_evaluation_table": {
      const cols =
        field.type === "medication_table" ? ["name", "dose", "purpose"] : ["type", "provider", "date"];
      const rows = (value as Record<string, string>[] | undefined) ?? [];
      const upd = (next: Record<string, string>[]) => onChange(next.length ? { value: next } : undefined);
      return (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c}>
                      <input
                        type={c === "date" ? "date" : "text"}
                        value={r[c] ?? ""}
                        onChange={(e) =>
                          upd(rows.map((x, j) => (j === i ? { ...x, [c]: e.target.value } : x)))
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <button className="secondary" onClick={() => upd(rows.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="secondary"
            onClick={() => upd([...rows, Object.fromEntries(cols.map((c) => [c, ""]))])}
          >
            Add row
          </button>
        </div>
      );
    }
    case "availability_grid": {
      const grid = (value as Record<string, number[]> | undefined) ?? {};
      const toggle = (d: string, b: number) => {
        const cur = grid[d] ?? [];
        const next = { ...grid, [d]: cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b].sort() };
        onChange({ value: next });
      };
      return (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                {BLOCKS.map(([a, b]) => (
                  <th key={a}>
                    {a}:00–{b}:00
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DAYS.map((d) => (
                <tr key={d}>
                  <th>{d}</th>
                  {BLOCKS.map((_, i) => (
                    <td key={i}>
                      <input
                        type="checkbox"
                        checked={(grid[d] ?? []).includes(i)}
                        onChange={() => toggle(d, i)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}
