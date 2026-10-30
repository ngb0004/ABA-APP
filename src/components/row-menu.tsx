"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { send } from "./actions";
import { RecordForm } from "./record-form";

type FormProps = Omit<Parameters<typeof RecordForm>[0], "onDone">;

/**
 * A compact "⋯" menu for a table row: an optional Edit (opens the given form
 * below the row's content), optional extra form actions (e.g. "Record benefits
 * check"), and an optional destructive action. Replaces rows of buttons.
 */
export function RowMenu(props: {
  /** What the row is, for the screen-reader label ("Actions for insurance"). */
  name: string;
  /** The edit form (opens in a dialog and closes once saved). */
  edit?: FormProps;
  /** More forms, each a menu item that opens its form in a dialog titled with its label. */
  actions?: { label: string; form: FormProps }[];
  remove?: { url: string; label?: string; confirm: string };
  testId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  /** The dialog showing: "edit", an index into props.actions, or none. */
  const [dialog, setDialog] = useState<"edit" | number | null>(null);
  const editing = dialog !== null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  useEffect(() => {
    if (!editing) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDialog(null);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [editing]);

  const action = typeof dialog === "number" ? props.actions?.[dialog] : undefined;
  const form = dialog === "edit" ? props.edit : action?.form;
  const title = action ? `${action.label}: ${props.name}` : `Edit ${props.name}`;

  async function remove() {
    setOpen(false);
    if (!props.remove || !window.confirm(props.remove.confirm)) return;
    setBusy(true);
    setError(null);
    const r = await send(props.remove.url, "DELETE", {});
    setBusy(false);
    if (!r.ok) return setError(String(r.data.error ?? "Request failed"));
    router.refresh();
  }

  return (
    <div className="row-menu" ref={ref} data-testid={props.testId}>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Actions for ${props.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        {busy ? "…" : "⋯"}
      </button>
      {open && (
        <div className="menu" role="menu">
          {props.edit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setDialog("edit");
              }}
            >
              Edit
            </button>
          )}
          {(props.actions ?? []).map((a, i) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setDialog(i);
              }}
            >
              {a.label}
            </button>
          ))}
          {props.remove && (
            <button type="button" role="menuitem" className="danger" onClick={remove}>
              {props.remove.label ?? "Remove"}
            </button>
          )}
        </div>
      )}
      {editing && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
            <div className="modal-head">
              <h3>{title}</h3>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setDialog(null)}>
                ×
              </button>
            </div>
            <RecordForm {...form!} onDone={() => setDialog(null)} />
          </div>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** A role shown as a dropdown; changing it confirms, saves, and signs the person out. */
export function RoleSelect(props: {
  url: string;
  name: string;
  role: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <select
        className="inline-select"
        aria-label={`Role for ${props.name}`}
        value={props.role}
        disabled={busy}
        onChange={async (e) => {
          const next = props.options.find((o) => o.value === e.target.value);
          if (
            !next ||
            !window.confirm(`Change ${props.name}'s role to ${next.label}? They will be signed out.`)
          )
            return;
          setBusy(true);
          setError(null);
          const r = await send(props.url, "PATCH", { role: next.value });
          setBusy(false);
          if (!r.ok) setError(String(r.data.error ?? "Could not change the role"));
          router.refresh();
        }}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </span>
  );
}

/** Choose a fictional sample file and load it, instead of one button per file. */
export function SamplePicker(props: {
  label: string;
  /** The sample's name is appended to this URL. */
  urlPrefix: string;
  samples: readonly string[];
  redirectKey?: string;
  redirectPrefix?: string;
  testId?: string;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div data-testid={props.testId}>
      <div className="row" style={{ marginTop: 8 }}>
        <select
          className="inline-select"
          aria-label={props.label}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">{props.label}…</option>
          {props.samples.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="secondary"
          disabled={!choice || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await send(`${props.urlPrefix}${encodeURIComponent(choice)}`, "POST", {});
            setBusy(false);
            if (!r.ok) return setError(String(r.data.error ?? "Could not load the sample"));
            setChoice("");
            if (props.redirectKey && r.data[props.redirectKey])
              router.push(`${props.redirectPrefix ?? ""}${String(r.data[props.redirectKey])}`);
            else router.refresh();
          }}
        >
          {busy ? "Loading…" : "Load sample"}
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
