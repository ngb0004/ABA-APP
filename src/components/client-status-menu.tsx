"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  INACTIVE_FROZEN,
  INACTIVE_NOTE_MAX,
  INACTIVE_REASONS,
  INACTIVE_REASON_LABELS,
  INACTIVE_STILL_EDITABLE,
} from "@/lib/client-status";
import { send } from "./actions";
import { RowMenu } from "./row-menu";

const errorText = (data: Record<string, unknown>, fallback: string) =>
  [String(data.error ?? fallback), ...((data.issues as string[] | undefined) ?? [])].join("\n");

/**
 * The client page's one ⋯ menu: "Mark inactive…" or "Reactivate". BCBA only (the page shows it only
 * to roles that may change the status; the API re-checks).
 */
export function ClientStatusMenu(props: { clientId: string; inactive: boolean; today: string }) {
  return (
    <RowMenu
      name="client"
      testId="client-menu"
      actions={[
        props.inactive
          ? {
              label: "Reactivate",
              title: "Reactivate client",
              content: (close) => <ReactivateConfirm clientId={props.clientId} onDone={close} />,
            }
          : {
              label: "Mark inactive…",
              title: "Mark client inactive",
              content: (close) => (
                <InactiveForm clientId={props.clientId} today={props.today} onDone={close} />
              ),
            },
      ]}
    />
  );
}

function InactiveForm({ clientId, today, onDone }: { clientId: string; today: string; onDone: () => void }) {
  const router = useRouter();
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      data-testid="inactive-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await send(`/api/clients/${clientId}/status`, "POST", {
          status: "inactive",
          date,
          reason,
          note: note.trim() || null,
        });
        setBusy(false);
        if (!r.ok) return setError(errorText(r.data, "Could not mark the client inactive"));
        onDone();
        router.refresh();
      }}
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Alerts and due dates stop for this client. {INACTIVE_FROZEN} {INACTIVE_STILL_EDITABLE} Every record is
        kept and stays readable; nothing is deleted.
      </p>
      <label htmlFor="inactive-date">Inactive since</label>
      <input
        id="inactive-date"
        type="date"
        required
        max={today}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <label htmlFor="inactive-reason">Reason</label>
      <select id="inactive-reason" required value={reason} onChange={(e) => setReason(e.target.value)}>
        <option value="">Choose a reason…</option>
        {INACTIVE_REASONS.map((r) => (
          <option key={r} value={r}>
            {INACTIVE_REASON_LABELS[r]}
          </option>
        ))}
      </select>
      <label htmlFor="inactive-note">Note (optional; no names, dates of birth, or member IDs)</label>
      <textarea
        id="inactive-note"
        maxLength={INACTIVE_NOTE_MAX}
        style={{ minHeight: 70, fontFamily: "inherit" }}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button type="submit" disabled={busy || !date || !reason}>
          {busy ? "Saving…" : "Mark inactive"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
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

function ReactivateConfirm({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <p style={{ marginTop: 0 }}>
        The client goes back on the caseload: alerts and due dates return, and new records can be added. The
        inactive date, reason, and note are cleared; the audit log keeps the history.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await send(`/api/clients/${clientId}/status`, "POST", { status: "active" });
            setBusy(false);
            if (!r.ok) return setError(errorText(r.data, "Could not reactivate the client"));
            onDone();
            router.refresh();
          }}
        >
          {busy ? "Saving…" : "Reactivate client"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="error" role="alert" style={{ whiteSpace: "pre-line" }}>
          {error}
        </div>
      )}
    </div>
  );
}
