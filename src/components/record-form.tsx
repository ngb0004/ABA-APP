"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";

export type FieldSpec = {
  /** Dotted path into the submitted object, e.g. "serviceAddress.city". */
  name: string;
  label: string;
  type?:
    | "text"
    | "date"
    | "number"
    | "time"
    | "select"
    | "checkbox"
    | "checkboxes"
    | "list"
    | "password"
    | "email";
  options?: readonly (string | { value: string; label: string })[];
  placeholder?: string;
  help?: string;
  /** Empty becomes null instead of "" (optional text and dates). */
  optional?: boolean;
  /** For type "list": the fields of each row. */
  fields?: FieldSpec[];
  /** For type "list": label for the add-row button. */
  addLabel?: string;
};

type Values = Record<string, unknown>;

const get = (o: Values, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Values)[k] : undefined), o);
function set(o: Values, path: string, value: unknown): Values {
  const [head, ...rest] = path.split(".");
  return {
    ...o,
    [head!]: rest.length ? set(((o[head!] as Values) ?? {}) as Values, rest.join("."), value) : value,
  };
}
const optionValue = (o: string | { value: string; label: string }) => (typeof o === "string" ? o : o.value);
const optionLabel = (o: string | { value: string; label: string }) =>
  typeof o === "string" ? o.replace(/_/g, " ") : o.label;
const toTime = (m: unknown) =>
  typeof m === "number"
    ? `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
    : "";
const fromTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return t ? h! * 60 + m! : null;
};

function blankFor(fields: FieldSpec[]): Values {
  let v: Values = {};
  for (const f of fields)
    v = set(
      v,
      f.name,
      f.type === "checkbox" ? false : f.type === "checkboxes" || f.type === "list" ? [] : "",
    );
  return v;
}

/** Converts form strings into the JSON the API validates (numbers, nulls). */
function normalize(fields: FieldSpec[], values: Values): Values {
  let out: Values = { ...values };
  for (const f of fields) {
    const v = get(values, f.name);
    if (f.type === "number")
      out = set(out, f.name, v === "" || v === undefined || v === null ? null : Number(v));
    else if (f.type === "list")
      out = set(
        out,
        f.name,
        ((v as Values[]) ?? []).map((row) => normalize(f.fields ?? [], row)),
      );
    else if (f.optional && (v === "" || v === undefined)) out = set(out, f.name, null);
  }
  return out;
}

function Input({
  f,
  value,
  onChange,
  idPrefix,
}: {
  f: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  idPrefix: string;
}) {
  const id = `${idPrefix}-${f.name}`;
  if (f.type === "checkbox")
    return (
      <label htmlFor={id} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
        <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {f.label}
      </label>
    );
  if (f.type === "checkboxes") {
    const list = (value as string[]) ?? [];
    return (
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>{f.label}</legend>
        {(f.options ?? []).map((o) => {
          const v = optionValue(o);
          return (
            <label key={v} style={{ display: "inline-flex", gap: 4, marginRight: 12, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={list.includes(v)}
                onChange={(e) => onChange(e.target.checked ? [...list, v] : list.filter((x) => x !== v))}
              />
              {optionLabel(o)}
            </label>
          );
        })}
      </fieldset>
    );
  }
  return (
    <div>
      <label htmlFor={id}>{f.label}</label>
      {f.type === "select" ? (
        <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(f.options ?? []).map((o) => (
            <option key={optionValue(o)} value={optionValue(o)}>
              {optionLabel(o)}
            </option>
          ))}
        </select>
      ) : f.type === "time" ? (
        <input
          id={id}
          type="time"
          value={toTime(value)}
          onChange={(e) => onChange(fromTime(e.target.value))}
        />
      ) : (
        <input
          id={id}
          type={f.type === "number" ? "number" : (f.type ?? "text")}
          step={f.type === "number" ? "any" : undefined}
          value={value === null || value === undefined ? "" : String(value)}
          placeholder={f.placeholder}
          autoComplete={f.type === "password" ? "new-password" : "off"}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {f.help && <div className="muted">{f.help}</div>}
    </div>
  );
}

/**
 * A form that posts JSON to an API route and shows the server's validation
 * errors. Used for every data-entry screen.
 */
export function RecordForm(props: {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  fields: FieldSpec[];
  initial?: Values;
  /** Fixed values sent with the form (not shown). */
  extra?: Values;
  submitLabel: string;
  /** After success: go to `${redirectPrefix}${response[redirectKey]}`, else refresh. */
  redirectKey?: string;
  redirectPrefix?: string;
  testId?: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>({ ...blankFor(props.fields), ...(props.initial ?? {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = props.testId ?? "form";
  return (
    <form
      data-testid={props.testId}
      className="record-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await send(props.url, props.method ?? "POST", {
          ...normalize(props.fields, values),
          ...props.extra,
        });
        setBusy(false);
        if (!r.ok)
          return setError(
            [
              String(r.data.error ?? "Could not save"),
              ...((r.data.issues as string[] | undefined) ?? []),
            ].join("\n"),
          );
        props.onDone?.();
        if (props.redirectKey && r.data[props.redirectKey])
          router.push(`${props.redirectPrefix ?? ""}${String(r.data[props.redirectKey])}`);
        else router.refresh();
      }}
    >
      <div className="form-grid">
        {props.fields.map((f) =>
          f.type === "list" ? (
            <fieldset
              key={f.name}
              className="form-wide"
              style={{ border: "1px solid var(--line, #ddd)", padding: 8 }}
            >
              <legend>{f.label}</legend>
              {((get(values, f.name) as Values[]) ?? []).map((row, i) => (
                <div key={i} className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
                  {(f.fields ?? []).map((sf) => (
                    <Input
                      key={sf.name}
                      f={sf}
                      idPrefix={`${prefix}-${f.name}-${i}`}
                      value={get(row, sf.name)}
                      onChange={(v) => {
                        const rows = [...((get(values, f.name) as Values[]) ?? [])];
                        rows[i] = set(rows[i]!, sf.name, v);
                        setValues(set(values, f.name, rows));
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setValues(
                        set(
                          values,
                          f.name,
                          ((get(values, f.name) as Values[]) ?? []).filter((_, j) => j !== i),
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setValues(
                    set(values, f.name, [
                      ...((get(values, f.name) as Values[]) ?? []),
                      blankFor(f.fields ?? []),
                    ]),
                  )
                }
              >
                {f.addLabel ?? "Add"}
              </button>
            </fieldset>
          ) : (
            <div key={f.name} className={f.type === "checkboxes" ? "form-wide" : undefined}>
              <Input
                f={f}
                idPrefix={prefix}
                value={get(values, f.name)}
                onChange={(v) => setValues(set(values, f.name, v))}
              />
            </div>
          ),
        )}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={busy} data-testid={props.testId ? `${props.testId}-submit` : undefined}>
          {busy ? "Saving…" : props.submitLabel}
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

/** A collapsible "Add …" or "Edit" form. */
export function FormToggle(props: {
  label: string;
  children: React.ReactNode;
  testId?: string;
  secondary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={props.secondary ? "secondary" : undefined}
        data-testid={props.testId}
        onClick={() => setOpen(!open)}
      >
        {open ? "Close" : props.label}
      </button>
      {open && <div className="panel">{props.children}</div>}
    </div>
  );
}
