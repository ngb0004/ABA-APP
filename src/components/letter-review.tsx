"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";

const CLASSES = ["approval", "denial", "reduction", "request_for_info", "p2p_offer"];

export function LetterReview({
  letter,
}: {
  letter: {
    id: string;
    filename: string;
    status: string;
    classification: string | null;
    extracted: {
      fields?: { field: string; quote: string; value: unknown; basis?: string; verified: boolean }[];
      requirements?: string[];
    };
  };
}) {
  const router = useRouter();
  const [cls, setCls] = useState(letter.classification ?? "approval");
  const [reqs, setReqs] = useState((letter.extracted.requirements ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const confirmed = letter.status === "confirmed";
  return (
    <div className="panel" data-testid="letter-review">
      <h3 style={{ marginTop: 0 }}>
        {letter.filename}{" "}
        <span className={`badge ${confirmed ? "ok" : "warn"}`}>
          {confirmed ? "confirmed by BCBA" : "needs BCBA confirmation"}
        </span>
      </h3>
      <label>Classification</label>
      <select
        value={cls}
        disabled={confirmed}
        onChange={(e) => setCls(e.target.value)}
        data-testid="letter-class"
      >
        {CLASSES.map((c) => (
          <option key={c} value={c}>
            {c.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <h3>Extracted (each value parsed from a quote verified against the letter)</h3>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Quote</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(letter.extracted.fields ?? []).map((f, i) => (
            <tr key={i}>
              <td>{f.field}</td>
              <td>
                {f.value === null ? "" : String(f.value)}
                {f.basis ? ` per ${f.basis}` : ""}
              </td>
              <td className="muted">“{f.quote}”</td>
              <td>
                <span className={`badge ${f.verified ? "ok" : "fail"}`}>
                  {f.verified ? "found in letter" : "not found: ignored"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>Next-request requirements (one per line)</label>
      <textarea
        disabled={confirmed}
        style={{ minHeight: 80, fontFamily: "inherit" }}
        value={reqs}
        onChange={(e) => setReqs(e.target.value)}
      />
      {!confirmed && (
        <button
          data-testid="confirm-letter"
          onClick={async () => {
            const r = await send(`/api/letters/${letter.id}/confirm`, "POST", {
              classification: cls,
              requirements: reqs
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean),
            });
            if (!r.ok) return setError(String(r.data.error));
            router.refresh();
          }}
        >
          Confirm letter details
        </button>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function ChecklistToggle({
  planId,
  itemKey,
  done,
}: {
  planId: string;
  itemKey: string;
  done: boolean;
}) {
  const router = useRouter();
  return (
    <input
      type="checkbox"
      checked={done}
      onChange={async (e) => {
        await send(`/api/plans/${planId}/packet/checklist`, "POST", { key: itemKey, done: e.target.checked });
        router.refresh();
      }}
    />
  );
}

export function ExportButton({ planId, disabled }: { planId: string; disabled: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span>
      <button
        data-testid="export-pdf"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch(`/api/plans/${planId}/export`, { method: "POST" });
          setBusy(false);
          if (!res.ok) return setError((await res.json().catch(() => ({}))).error ?? "Export failed");
          router.refresh();
          window.location.href = `/api/plans/${planId}/export`;
        }}
      >
        {busy ? "Exporting…" : "Export packet PDF"}
      </button>
      {error && (
        <div className="error" role="alert" data-testid="export-error">
          {error}
        </div>
      )}
    </span>
  );
}
