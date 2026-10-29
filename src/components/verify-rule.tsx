"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";

export function VerifyRule({
  ruleId,
  verified,
  section,
}: {
  ruleId: string;
  verified: boolean;
  section: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sec, setSec] = useState(section ?? "");
  const [error, setError] = useState<string | null>(null);
  if (verified)
    return (
      <button
        className="secondary"
        onClick={async () => {
          await send(`/api/payors/rules/${ruleId}/verify`, "POST", { verified: false, section: null });
          router.refresh();
        }}
      >
        Mark unverified
      </button>
    );
  if (!open)
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        Verify…
      </button>
    );
  return (
    <div>
      <input
        placeholder="Section checked in the official document"
        value={sec}
        onChange={(e) => setSec(e.target.value)}
      />
      <button
        onClick={async () => {
          const r = await send(`/api/payors/rules/${ruleId}/verify`, "POST", {
            verified: true,
            section: sec,
          });
          if (!r.ok) return setError(String(r.data.error));
          router.refresh();
        }}
      >
        Confirm verified
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
