"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AddOption } from "./assessment-fields";
import { RecordForm } from "./record-form";
import { SamplePicker } from "./row-menu";

type Mode = "enter" | "import";
const TITLES: Record<Mode, string> = { enter: "Enter scores", import: "Import a file" };

/** Everything a keyboard can reach inside an element, in order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one "Add assessment" control: a menu with "Enter scores" and "Import a file". Either
 * opens a dialog where the assessment is chosen first (grouped Skills / Standardized / Other),
 * because any file format can hold any assessment. VB-MAPP opens its workbook import page.
 */
export function AddAssessment(props: {
  url: string;
  importUrl: string;
  groups: { label: string; options: AddOption[] }[];
  accept: string;
  demo: boolean;
  /** Bundled synthetic samples and the assessment value each one holds. */
  samples: { name: string; type: string }[];
  testId?: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [chosen, setChosen] = useState<AddOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => {
    setMode(null);
    setChosen(null);
    setError(null);
    // Back to the control that opened the dialog.
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!menu) return;
    const shut = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !wrap.current?.contains(e.target as Node))
        setMenu(false);
    };
    document.addEventListener("mousedown", shut);
    document.addEventListener("keydown", shut);
    return () => {
      document.removeEventListener("mousedown", shut);
      document.removeEventListener("keydown", shut);
    };
  }, [menu]);

  useEffect(() => {
    if (!mode) return;
    // Focus moves into the dialog (the assessment choice comes first) and Tab stays inside it.
    dialog.current?.querySelector<HTMLElement>("#add-assessment-type")?.focus();
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close();
      if (e.key !== "Tab" || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      const inside = dialog.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [mode]);

  const open = (m: Mode) => {
    setMenu(false);
    setMode(m);
  };

  const options = props.groups.flatMap((g) => g.options);
  const title = mode === "enter" && chosen ? (chosen.title ?? chosen.label) : mode ? TITLES[mode] : "";
  const samples = chosen ? props.samples.filter((s) => s.type === chosen.value) : [];

  return (
    <div data-testid={props.testId}>
      <div className="row-menu" ref={wrap}>
        <button
          ref={trigger}
          type="button"
          className="secondary"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          Add assessment ▾
        </button>
        {menu && (
          <div className="menu menu-left" role="menu">
            <button type="button" role="menuitem" onClick={() => open("enter")}>
              Enter scores…
            </button>
            <button type="button" role="menuitem" onClick={() => open("import")}>
              Import a file…
            </button>
          </div>
        )}
      </div>
      {mode && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={dialog}>
            <div className="modal-head">
              <h3>{title}</h3>
              <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
                ×
              </button>
            </div>
            <label htmlFor="add-assessment-type">Assessment</label>
            <select
              id="add-assessment-type"
              value={chosen?.value ?? ""}
              onChange={(e) => {
                const o = options.find((x) => x.value === e.target.value) ?? null;
                if (o?.href) return router.push(o.href);
                setChosen(o);
                setError(null);
              }}
            >
              <option value="">Choose…</option>
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
            {mode === "enter" && chosen && (
              <RecordForm
                key={chosen.value}
                url={props.url}
                fields={chosen.fields ?? []}
                extra={chosen.extra}
                initial={chosen.initial}
                submitLabel="Save draft"
                testId="assessment-form"
                onDone={close}
              />
            )}
            {mode === "import" && (
              <div data-testid="assessment-import">
                <p className="muted">
                  Excel (.xlsx, .xls), .csv, PDF, an image (.png, .jpg, .webp), .txt, or Word (.docx), up to
                  15 MB. Scores are read on our server without AI and shown for you to check; the file itself
                  is not kept. Names, birth dates, and IDs are flagged and never stored.
                </p>
                {chosen ? (
                  <>
                    {!props.demo && (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const fd = new FormData(e.currentTarget);
                          fd.set("type", chosen.value);
                          setBusy(true);
                          setError(null);
                          const res = await fetch(props.importUrl, { method: "POST", body: fd });
                          const data = await res.json().catch(() => ({}));
                          setBusy(false);
                          if (!res.ok) return setError(String(data.error ?? "Upload failed"));
                          router.push(`/assessments/imports/${data.importId}`);
                        }}
                      >
                        <label htmlFor="assessment-import-file">File</label>
                        <div className="row">
                          <input
                            id="assessment-import-file"
                            type="file"
                            name="file"
                            accept={props.accept}
                            required
                          />
                          <button disabled={busy}>{busy ? "Reading…" : "Upload"}</button>
                        </div>
                      </form>
                    )}
                    {props.demo && (
                      <p className="muted">
                        Uploading your own files is turned off on the demo site. Only the fictional sample
                        files below are accepted.
                      </p>
                    )}
                    {samples.length > 0 ? (
                      <SamplePicker
                        label={
                          props.demo ? "Load a fictional sample file" : "Or load a fictional sample file"
                        }
                        urlPrefix={`${props.importUrl}?type=${encodeURIComponent(chosen.value)}&sample=`}
                        samples={samples.map((s) => s.name)}
                        redirectKey="importId"
                        redirectPrefix="/assessments/imports/"
                        testId="sample-score-files"
                      />
                    ) : (
                      props.demo && <p className="muted">There is no sample file for this assessment yet.</p>
                    )}
                    {error && (
                      <div className="error" role="alert">
                        {error}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="muted">
                    Choose the assessment first: one file format can hold any assessment.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
