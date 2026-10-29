"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { send } from "./actions";

export function ImportConfirm({
  importId,
  clientId,
  phiDetected,
}: {
  importId: string;
  clientId: string;
  phiDetected: boolean;
}) {
  const router = useRouter();
  const [strip, setStrip] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      {phiDetected && (
        <label style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} /> Strip the
          child&apos;s name / date of birth from this import (they are never stored)
        </label>
      )}
      <div className="row">
        <button
          data-testid="confirm-import"
          disabled={phiDetected && !strip}
          onClick={async () => {
            const r = await send(`/api/vbmapp/imports/${importId}/confirm`, "POST", { stripPhi: strip });
            if (!r.ok) return setError(String(r.data.error));
            router.push(`/clients/${clientId}/vbmapp`);
            router.refresh();
          }}
        >
          I reviewed the grid and flags: save
        </button>
        <button
          className="secondary"
          onClick={async () => {
            await send(`/api/vbmapp/imports/${importId}/discard`, "POST", {});
            router.push(`/clients/${clientId}/vbmapp`);
          }}
        >
          Discard
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
