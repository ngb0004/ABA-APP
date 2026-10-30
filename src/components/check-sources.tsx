"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";
import { summarizeChecks } from "./payor-display";

type Check = { name: string; health: string; newVersion: boolean; error: string | null };

/** "Check sources now", followed by a one-line summary of what the check found. */
export function CheckSourcesButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        data-testid="check-sources"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setSummary(null);
          const r = await send("/api/payors/sources/check", "POST", {});
          setBusy(false);
          if (!r.ok) return setError(String(r.data.error ?? "Request failed"));
          setSummary(summarizeChecks((r.data.checks as Check[] | undefined) ?? []));
          router.refresh();
        }}
      >
        {busy ? "Checking sources…" : "Check sources now"}
      </button>
      {summary && (
        <p className="alert info" role="status" data-testid="check-sources-summary">
          {summary} Documents without a public link (uploaded copies and secondary sources) are not checked.
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
