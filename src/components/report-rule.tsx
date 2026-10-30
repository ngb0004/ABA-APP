"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { REPORT_NOTE_MAX as NOTE_MAX, REPORT_REASONS as REASONS } from "@/lib/payors/report-reasons";
import { send } from "./actions";
import { RowMenu } from "./row-menu";

/**
 * "Report a problem" with a payor rule, from the rule's ⋯ menu: what is wrong, plus an optional
 * note, in a dialog. Yoma's reviewers follow up.
 */
export function ReportRule({ ruleId, name }: { ruleId: string; name: string }) {
  return (
    <RowMenu
      name={name}
      testId={`rule-menu-${ruleId}`}
      actions={[
        { label: "Report a problem", content: (close) => <ReportRuleForm ruleId={ruleId} onClose={close} /> },
      ]}
    />
  );
}

function ReportRuleForm({ ruleId, onClose }: { ruleId: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // Unique per form, even when the same rule shows in more than one place.
  const id = useId();

  if (sent)
    return (
      <div>
        <p role="status" data-testid={`report-sent-${ruleId}`}>
          Thanks. Yoma&apos;s reviewers will check this rule against the payor&apos;s current document.
        </p>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  return (
    <div className="report-form" data-testid={`report-form-${ruleId}`}>
      <label htmlFor={`${id}-reason`}>What&apos;s wrong?</label>
      <select
        id={`${id}-reason`}
        value={reason}
        autoFocus
        onChange={(e) => setReason(e.target.value)}
        style={{ width: "100%" }}
      >
        <option value="">Choose one…</option>
        {REASONS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-note`}>Details (optional)</label>
      <p className="alert warn" id={`${id}-phi`} style={{ margin: "4px 0" }}>
        Don&apos;t include client names, dates of birth, or member IDs. Describe what the payor told you or
        what the letter says about the rule.
      </p>
      <textarea
        id={`${id}-note`}
        aria-describedby={`${id}-phi ${id}-count`}
        value={note}
        maxLength={NOTE_MAX}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Our denial letter says reassessments are due every 6 months, not 12"
      />
      <div className="muted" id={`${id}-count`}>
        {note.length}/{NOTE_MAX} characters
      </div>
      <div className="row">
        <button
          disabled={busy || !reason}
          data-testid={`submit-report-${ruleId}`}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await send(`/api/payors/rules/${ruleId}/report`, "POST", { reason, note });
            setBusy(false);
            if (!r.ok)
              return setError(
                String(r.data.error ?? "Request failed") +
                  (Array.isArray(r.data.issues) ? `\n${(r.data.issues as string[]).join("\n")}` : ""),
              );
            setSent(true);
          }}
        >
          {busy ? "Sending…" : "Send report"}
        </button>
        <button className="secondary" data-testid={`cancel-report-${ruleId}`} onClick={onClose}>
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

/** Curators only: close a report, saying what was done (the API checks the curator flag). */
export function ResolveReport({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        className="secondary small"
        disabled={busy}
        data-testid={`resolve-${reportId}`}
        onClick={async () => {
          const resolution = window.prompt("What was done? (e.g. rule corrected, no change needed)")?.trim();
          if (!resolution) return;
          setBusy(true);
          setError(null);
          const r = await send(`/api/payors/reports/${reportId}/resolve`, "POST", { resolution });
          setBusy(false);
          if (!r.ok) return setError(String(r.data.error ?? "Request failed"));
          router.refresh();
        }}
      >
        {busy ? "Working…" : "Resolve"}
      </button>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </span>
  );
}
