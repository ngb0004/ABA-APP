"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

export async function send(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : {};
  return { ok: res.ok, status: res.status, data };
}

/** Button that calls an API route and refreshes the page. Shows the server's error message on failure. */
export function ActionButton(props: {
  url: string;
  method?: string;
  body?: unknown;
  children: ReactNode;
  secondary?: boolean;
  /** Compact size for buttons inside lists. */
  small?: boolean;
  /** Screen-reader name when the visible text is short. */
  ariaLabel?: string;
  disabled?: boolean;
  confirm?: string;
  redirectKey?: string;
  redirectPrefix?: string;
  testId?: string;
  /** Extra text fields sent with the file. */
  fields?: { name: string; label: string; type?: "text" | "date"; placeholder?: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        data-testid={props.testId}
        className={
          [props.secondary && "secondary", props.small && "small"].filter(Boolean).join(" ") || undefined
        }
        aria-label={props.ariaLabel}
        disabled={busy || props.disabled}
        onClick={async () => {
          if (props.confirm && !window.confirm(props.confirm)) return;
          setBusy(true);
          setError(null);
          const r = await send(props.url, props.method ?? "POST", props.body ?? {});
          setBusy(false);
          if (!r.ok)
            return setError(
              String(r.data.error ?? "Request failed") +
                (Array.isArray(r.data.issues) ? `\n${(r.data.issues as string[]).join("\n")}` : ""),
            );
          if (props.redirectKey && r.data[props.redirectKey])
            router.push(`${props.redirectPrefix ?? ""}${String(r.data[props.redirectKey])}`);
          else router.refresh();
        }}
      >
        {busy ? "Working…" : props.children}
      </button>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </span>
  );
}

export function UploadForm(props: {
  url: string;
  accept: string;
  label: string;
  redirectKey?: string;
  redirectPrefix?: string;
  testId?: string;
  /** Extra text fields sent with the file. */
  fields?: { name: string; label: string; type?: "text" | "date"; placeholder?: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      data-testid={props.testId}
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        setError(null);
        const res = await fetch(props.url, { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        setBusy(false);
        if (!res.ok) return setError(String(data.error ?? "Upload failed"));
        if (props.redirectKey && data[props.redirectKey])
          router.push(`${props.redirectPrefix ?? ""}${data[props.redirectKey]}`);
        else router.refresh();
      }}
    >
      <label>{props.label}</label>
      {props.fields?.map((f) => (
        <div key={f.name}>
          <label>{f.label}</label>
          <input name={f.name} type={f.type ?? "text"} placeholder={f.placeholder} />
        </div>
      ))}
      <div className="row">
        <input type="file" name="file" accept={props.accept} required />
        <button disabled={busy}>{busy ? "Uploading…" : "Upload"}</button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

export function LogoutButton() {
  return (
    <button
      className="secondary"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.href = "/login";
      }}
    >
      Sign out
    </button>
  );
}

export function Html({ html, className }: { html: string; className?: string }) {
  // Content is escaped by the server-side renderer (src/lib/firewall renderTokens).
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
