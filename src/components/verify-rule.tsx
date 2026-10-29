"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";

type Doc = { id: string; name: string; current: string | null };

/** Verify a rule with proof: pick the official document, then paste the exact sentence that states the rule. */
export function VerifyRule({
  ruleId,
  verified,
  documents,
  defaultDocumentId,
  section,
}: {
  ruleId: string;
  verified: boolean;
  documents: Doc[];
  defaultDocumentId: string | null;
  section: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [docId, setDocId] = useState(
    defaultDocumentId && documents.some((d) => d.id === defaultDocumentId)
      ? defaultDocumentId
      : (documents[0]?.id ?? ""),
  );
  const [sec, setSec] = useState(section ?? "");
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (verified)
    return (
      <button
        className="secondary"
        onClick={async () => {
          const note = window.prompt("Why is this verification no longer valid? (optional)") ?? null;
          const r = await send(`/api/payors/rules/${ruleId}/revoke`, "POST", { note });
          if (!r.ok) return setError(String(r.data.error));
          router.refresh();
        }}
      >
        Revoke
      </button>
    );
  if (!open)
    return (
      <button className="secondary" data-testid={`verify-${ruleId}`} onClick={() => setOpen(true)}>
        Verify with a quote…
      </button>
    );
  return (
    <div style={{ minWidth: 260 }}>
      <label>Official document</label>
      <select value={docId} onChange={(e) => setDocId(e.target.value)} style={{ width: "100%" }}>
        {documents.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
            {d.current ? ` (${d.current})` : " (not fetched yet)"}
          </option>
        ))}
      </select>
      <label>Section</label>
      <input
        value={sec}
        onChange={(e) => setSec(e.target.value)}
        placeholder="e.g. 803.10"
        style={{ width: "100%" }}
      />
      <label>Exact sentence from the document</label>
      <textarea
        data-testid={`quote-${ruleId}`}
        value={quote}
        onChange={(e) => setQuote(e.target.value)}
        style={{ minHeight: 70, fontFamily: "inherit" }}
        placeholder="Copy and paste the sentence that states this rule, including any numbers"
      />
      <div className="row">
        <button
          disabled={busy || !docId}
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
