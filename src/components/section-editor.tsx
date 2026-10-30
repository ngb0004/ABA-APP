"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Html, send } from "./actions";
import { requestDraft } from "./draft-request";

type Item = { key: string; label: string; status: "answered" | "none" | null; auto: boolean };

export function SectionCard(props: {
  planId: string;
  section: {
    key: string;
    title: string;
    state: string;
    ordinal: number;
    html: string;
    content: string;
    items: Item[];
    bcbaOnly: boolean;
    /** Conditional sections (group, school, telehealth) can be marked not applicable. */
    conditional?: boolean;
    notApplicableReason?: string | null;
  };
  tokens: { key: string; label: string; display: string }[];
  canDraft: boolean;
  canEdit: boolean;
  canApprove: boolean;
}) {
  const { planId, section: s } = props;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.content);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A draft just returned, shown until the page refresh brings the saved section.
  const [fresh, setFresh] = useState<{ base: string; content: string; html: string } | null>(null);
  const shown =
    fresh && fresh.base === s.content && fresh.content !== s.content
      ? { content: fresh.content, html: fresh.html, state: "draft" }
      : { content: s.content, html: s.html, state: s.state };
  // Optimistic item answers, so a click registers before the refresh lands.
  const [local, setLocal] = useState<Record<string, "answered" | "none">>({});
  const items = s.items.map((i) => ({ ...i, status: local[i.key] ?? i.status }));
  const base = `/api/plans/${planId}/sections/${s.key}`;
  const na = shown.state === "not_applicable";
  // Approved and not-applicable sections are closed until reopened.
  const approved = shown.state === "approved" || na;
  const openItems = items.filter((i) => i.status === null).length;

  async function call(label: string, url: string, method: string, body?: unknown) {
    setBusy(label);
    setError(null);
    setNote(null);
    const r = await send(url, method, body ?? {});
    setBusy(null);
    if (!r.ok) {
      setError(String(r.data.error ?? "Request failed"));
      return false;
    }
    if (Array.isArray(r.data.unsourcedNumbers) && r.data.unsourcedNumbers.length)
      setNote(
        `Numbers typed without a source: ${(r.data.unsourcedNumbers as string[]).join(", ")}. They will be listed in the audit.`,
      );
    router.refresh();
    return true;
  }

  async function draft() {
    setBusy("draft");
    setError(null);
    setNote(null);
    const r = await requestDraft(`${base}/draft`);
    setBusy(null);
    if (!r.ok) return setError(String(r.data.error ?? "Request failed"));
    if (typeof r.data.text === "string" && typeof r.data.html === "string")
      setFresh({ base: s.content, content: r.data.text, html: r.data.html });
    router.refresh();
  }

  return (
    <div className="panel" id={`section-${s.key}`} data-testid={`section-${s.key}`}>
      <h2 style={{ marginTop: 0 }}>
        {s.ordinal}. {s.title}{" "}
        <span className={`badge ${na ? "na" : shown.state}`} data-testid={`state-${s.key}`}>
          {na ? "not applicable" : shown.state}
        </span>
      </h2>
      {na ? (
        <p className="muted" data-testid={`na-${s.key}`}>
          Not applicable to this request{s.notApplicableReason ? `: ${s.notApplicableReason}` : ""}.
        </p>
      ) : shown.content.trim() ? (
        <Html
          className="section-body"
          html={shown.html
            .split(/\n{2,}/)
            .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
            .join("")}
        />
      ) : (
        <p className="muted">No content yet.</p>
      )}
      {!approved && (
        <div className="row">
          {props.canDraft && !s.bcbaOnly && (
            <button data-testid={`draft-${s.key}`} disabled={!!busy} onClick={() => void draft()}>
              {busy === "draft" ? "Drafting…" : shown.content ? "Redraft with AI" : "Draft with AI"}
            </button>
          )}
          {props.canEdit && (
            <button
              className="secondary"
              onClick={() => {
                setText(shown.content);
                setEditing(!editing);
              }}
            >
              {editing ? "Close editor" : "Edit"}
            </button>
          )}
        </div>
      )}
      {editing && !approved && (
        <div style={{ marginTop: 8 }}>
          <textarea data-testid={`editor-${s.key}`} value={text} onChange={(e) => setText(e.target.value)} />
          <details>
            <summary className="muted">
              Available sourced values ({props.tokens.length}). Insert as {"{{key}}"}.
            </summary>
            <div className="tokens">
              {props.tokens.map((t) => (
                <div key={t.key}>
                  <code>{`{{${t.key}}}`}</code>: {t.label} = {t.display}
                </div>
              ))}
            </div>
          </details>
          <button
            data-testid={`save-${s.key}`}
            disabled={!!busy}
            onClick={async () => {
              if (await call("save", base, "PUT", { content: text })) setEditing(false);
            }}
          >
            Save edits
          </button>
        </div>
      )}
      {!na && (
        <details open={!approved && openItems > 0}>
          <summary>
            Required items ({items.length - openItems}/{items.length} resolved)
          </summary>
          <table>
            <tbody>
              {items.map((i) => (
                <tr key={i.key}>
                  <td>
                    {i.label}
                    {i.auto && <span className="muted"> (from intake)</span>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {(["answered", "none"] as const).map((st) => (
                      <label key={st} style={{ display: "inline", fontWeight: 400, marginRight: 8 }}>
                        <input
                          type="radio"
                          name={`${s.key}-${i.key}`}
                          checked={i.status === st}
                          disabled={approved || !props.canEdit}
                          onChange={() => {
                            setLocal((l) => ({ ...l, [i.key]: st }));
                            void call("item", `${base}/items`, "POST", { itemKey: i.key, status: st });
                          }}
                        />{" "}
                        {st === "answered" ? "Addressed" : "None"}
                      </label>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        {props.canApprove && !approved && (
          <button
            data-testid={`approve-${s.key}`}
            disabled={!!busy}
            onClick={() => call("approve", `${base}/approve`, "POST")}
          >
            Approve this section
          </button>
        )}
        {props.canApprove && !approved && s.conditional && (
          <button
            className="secondary"
            data-testid={`na-button-${s.key}`}
            disabled={!!busy}
            onClick={() => {
              const reason = window.prompt("Why does this section not apply to this request?");
              if (reason?.trim()) void call("na", `${base}/not-applicable`, "POST", { reason });
            }}
          >
            Not applicable…
          </button>
        )}
        {props.canApprove && approved && (
          <button className="secondary" onClick={() => call("reopen", `${base}/reopen`, "POST")}>
            Reopen
          </button>
        )}
      </div>
      {note && <div className="alert warn">{note}</div>}
      {error && (
        <div className="error" role="alert" data-testid={`error-${s.key}`}>
          {error}
        </div>
      )}
    </div>
  );
}
