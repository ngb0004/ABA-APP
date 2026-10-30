"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";
import { revokeNoteFromPrompt } from "./payor-display";

/** `current` is the version label or fetch date of the latest copy; null when no copy exists yet. */
type Doc = { id: string; name: string; current: string | null };

/** Verify a rule with proof: pick the official document, then paste the exact sentence that states the rule. */
export function VerifyRule({
  ruleId,
  verified,
  documents,
  payorDocumentIds = [],
  defaultDocumentId,
  section,
  recordedQuote,
}: {
  ruleId: string;
  verified: boolean;
  documents: Doc[];
  /** Ids of the documents this payor's own rules cite. They are listed first. */
  payorDocumentIds?: string[];
  defaultDocumentId: string | null;
  section: string | null;
  /** The sentence the rule was read from, if recorded. The reviewer still has to choose to use it. */
  recordedQuote?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [docId, setDocId] = useState(
    defaultDocumentId && documents.some((d) => d.id === defaultDocumentId)
      ? defaultDocumentId
      : (documents.find((d) => payorDocumentIds.includes(d.id) && d.current)?.id ??
          documents.find((d) => d.current)?.id ??
          ""),
  );
  const [sec, setSec] = useState(section ?? "");
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (verified)
    return (
      <span>
        <button
          className="secondary"
          disabled={busy}
          data-testid={`revoke-${ruleId}`}
          onClick={async () => {
            const answer = revokeNoteFromPrompt(
              window.prompt("Why is this verification no longer valid? (optional)"),
            );
            if (!answer.revoke) return;
            setBusy(true);
            setError(null);
            const r = await send(`/api/payors/rules/${ruleId}/revoke`, "POST", { note: answer.note });
            setBusy(false);
            if (!r.ok) return setError(String(r.data.error ?? "Request failed"));
            router.refresh();
          }}
        >
          {busy ? "Working…" : "Revoke"}
        </button>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </span>
    );
  if (!open)
    return (
      <button className="secondary" data-testid={`verify-${ruleId}`} onClick={() => setOpen(true)}>
        Verify with a quote…
      </button>
    );

  const own = documents.filter((d) => payorDocumentIds.includes(d.id));
  const others = documents.filter((d) => !payorDocumentIds.includes(d.id));
  const selected = documents.find((d) => d.id === docId);
  // A document with no copy cannot be checked against; it stays visible (greyed out) so the cited one is clear.
  const option = (d: Doc) => (
    <option key={d.id} value={d.id} disabled={!d.current && d.id !== docId}>
      {d.name}
      {d.current ? ` (${d.current})` : " (no copy yet)"}
    </option>
  );
  return (
    <div className="verify-form">
      <label>Official document</label>
      <select value={docId} onChange={(e) => setDocId(e.target.value)} style={{ width: "100%" }}>
        {own.length > 0 && <optgroup label="Cited by this payor">{own.map(option)}</optgroup>}
        {others.length > 0 &&
          (own.length > 0 ? (
            <optgroup label="Other documents">{others.map(option)}</optgroup>
          ) : (
            others.map(option)
          ))}
      </select>
      {selected && !selected.current && (
        <div className="muted">
          There is no copy of this document yet, so a quote cannot be checked against it.
        </div>
      )}
      <label>Section</label>
      <input
        value={sec}
        onChange={(e) => setSec(e.target.value)}
        placeholder="e.g. 803.10"
        style={{ width: "100%" }}
      />
      <label>Exact sentence from the document</label>
      {recordedQuote && !quote && (
        <div className="muted">
          Recorded when the rule was written. Check it against the document before using it.{" "}
          <button
            className="secondary"
            data-testid={`use-quote-${ruleId}`}
            onClick={() => setQuote(recordedQuote)}
          >
            Use the recorded quote
          </button>
        </div>
      )}
      <textarea
        data-testid={`quote-${ruleId}`}
        value={quote}
        onChange={(e) => setQuote(e.target.value)}
        style={{ minHeight: 70, fontFamily: "inherit" }}
        placeholder="Copy and paste the sentence that states this rule, including any numbers"
      />
      <div className="row">
        <button
          disabled={busy || !docId || !selected?.current}
          data-testid={`submit-verify-${ruleId}`}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await send(`/api/payors/rules/${ruleId}/verify`, "POST", {
              quote,
              section: sec || null,
              documentId: docId,
            });
            setBusy(false);
            if (!r.ok) return setError(String(r.data.error));
            setOpen(false);
            router.refresh();
          }}
        >
          {busy ? "Checking…" : "Verify"}
        </button>
        <button className="secondary" onClick={() => setOpen(false)}>
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
