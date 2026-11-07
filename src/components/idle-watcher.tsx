"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Idle sign-out warning (rules in src/lib/auth/idle.ts). The person's own typing, clicking,
 * scrolling, or touching sends a keep-alive at most once a minute; nothing else does. Shortly
 * before the server would sign out, a warning offers "Stay signed in". Tabs share the time of the
 * last keep-alive through localStorage, so one active tab keeps the others from warning. The
 * server stays the authority: the warning and the sign-out both re-read the time left first.
 */
const PING_EVERY_MS = 60_000;
const STORAGE_KEY = "yoma.lastKeepAlive";
const EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

function sharedLastPing(): number {
  try {
    return Number(window.localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}
function shareLastPing(t: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(t));
  } catch {
    // Private windows can refuse storage; this tab still keeps its own time.
  }
}

export function IdleWatcher({
  timeoutSeconds,
  warningSeconds,
}: {
  timeoutSeconds: number;
  warningSeconds: number;
}) {
  const [warning, setWarning] = useState<number | null>(null);
  const stay = useRef<() => void>(() => undefined);

  useEffect(() => {
    let lastPing = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const signOut = async () => {
      stopped = true;
      clearTimeout(timer);
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
      window.location.href = "/login?reason=idle";
    };
    /** Waits until `remainingMs` is down to the warning period, then checks with the server. */
    const schedule = (remainingMs: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void check(), Math.max(0, remainingMs - warningSeconds * 1000));
    };
    /** Re-reads the time left from the server (reading is not activity), then warns, signs out, or waits. */
    const check = async () => {
      let remaining: number | null = null;
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (res.ok) remaining = Number((await res.json()).idleRemainingSeconds);
        else if (res.status === 401) remaining = 0;
      } catch {
        // Network trouble: fall back to this tab's own clock.
        remaining = Math.floor((lastPing + timeoutSeconds * 1000 - Date.now()) / 1000);
      }
      if (remaining === null || Number.isNaN(remaining)) remaining = timeoutSeconds;
      if (remaining <= 0) return signOut();
      if (remaining <= warningSeconds + 1) {
        setWarning(remaining);
        clearTimeout(timer);
        timer = setTimeout(() => void check(), remaining * 1000 + 500);
      } else {
        setWarning(null);
        schedule(remaining * 1000);
      }
    };
    const keepAlive = async () => {
      lastPing = Date.now();
      shareLastPing(lastPing);
      try {
        const res = await fetch("/api/auth/keepalive", { method: "POST" });
        if (res.status === 401) return signOut();
        const remaining = res.ok ? Number((await res.json()).idleRemainingSeconds) : timeoutSeconds;
        setWarning(null);
        schedule((Number.isNaN(remaining) ? timeoutSeconds : remaining) * 1000);
      } catch {
        schedule(timeoutSeconds * 1000);
      }
    };
    const onActivity = () => {
      if (Date.now() - Math.max(lastPing, sharedLastPing()) >= PING_EVERY_MS) void keepAlive();
    };
    const onStorage = (e: StorageEvent) => {
      const t = e.key === STORAGE_KEY ? Number(e.newValue) || 0 : 0;
      if (t <= lastPing) return;
      // Another tab is in use: this one waits again from that tab's keep-alive.
      lastPing = t;
      setWarning(null);
      schedule(timeoutSeconds * 1000 - (Date.now() - t));
    };

    stay.current = () => void keepAlive();
    shareLastPing(lastPing);
    schedule(timeoutSeconds * 1000);
    for (const e of EVENTS) window.addEventListener(e, onActivity, { passive: true, capture: true });
    window.addEventListener("storage", onStorage);
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const e of EVENTS) window.removeEventListener(e, onActivity, { capture: true });
      window.removeEventListener("storage", onStorage);
    };
  }, [timeoutSeconds, warningSeconds]);

  if (warning === null) return null;
  const minutes = Math.max(1, Math.ceil(warning / 60));
  return (
    <div
      className="idle-warning"
      role="alertdialog"
      aria-labelledby="idle-warning-text"
      data-testid="idle-warning"
    >
      <p id="idle-warning-text">
        You will be signed out in about {minutes} minute{minutes === 1 ? "" : "s"} because of inactivity.
      </p>
      <button onClick={() => stay.current()}>Stay signed in</button>
    </div>
  );
}
