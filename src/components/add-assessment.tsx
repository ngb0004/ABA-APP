"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AddOption } from "./assessment-fields";
import { RecordForm } from "./record-form";

/**
 * The one "Add assessment" control: a dropdown of catalog types (grouped Skills / Standardized /
 * Other). Choosing a type opens its entry form in a dialog; VB-MAPP opens its workbook import.
 */
export function AddAssessment(props: {
  url: string;
  groups: { label: string; options: AddOption[] }[];
  testId?: string;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<AddOption | null>(null);

  useEffect(() => {
    if (!chosen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setChosen(null);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [chosen]);

  return (
    <div data-testid={props.testId}>
      <select
        className="inline-select"
        aria-label="Add assessment"
        value=""
        onChange={(e) => {
          const o = props.groups.flatMap((g) => g.options).find((x) => x.value === e.target.value);
          if (!o) return;
          if (o.href) router.push(o.href);
          else setChosen(o);
        }}
      >
        <option value="">Add assessment…</option>
        {props.groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {chosen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setChosen(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={chosen.title ?? chosen.label}>
            <div className="modal-head">
              <h3>{chosen.title ?? chosen.label}</h3>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setChosen(null)}>
                ×
              </button>
            </div>
            <RecordForm
              key={chosen.value}
              url={props.url}
              fields={chosen.fields ?? []}
              extra={chosen.extra}
              initial={chosen.initial}
              submitLabel="Save draft"
              testId="assessment-form"
              onDone={() => setChosen(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
