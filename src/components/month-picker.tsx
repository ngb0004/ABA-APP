"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { monthLabel, neighbours, type SessionMonth } from "@/lib/session-months";

/** Choose which month of sessions to show: a dropdown of months that have sessions, plus ‹ ›. */
export function MonthPicker({ months, month }: { months: SessionMonth[]; month: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const go = (m: string | null) => {
    if (!m) return;
    const q = new URLSearchParams(search.toString());
    q.set("month", m);
    router.push(`${pathname}?${q.toString()}#sessions`, { scroll: false });
  };
  const { prev, next } = neighbours(months, month);
  return (
    <div className="row" style={{ gap: 6 }} data-testid="session-month">
      <button
        type="button"
        className="icon-btn"
        aria-label="Previous month with sessions"
        disabled={!prev}
        onClick={() => go(prev)}
      >
        ‹
      </button>
      <select className="inline-select" aria-label="Month" value={month} onChange={(e) => go(e.target.value)}>
        {months.map((m) => (
          <option key={m.month} value={m.month}>
            {monthLabel(m.month)} ({m.sessions} {m.sessions === 1 ? "session" : "sessions"})
          </option>
        ))}
      </select>
      <button
        type="button"
        className="icon-btn"
        aria-label="Next month with sessions"
        disabled={!next}
        onClick={() => go(next)}
      >
        ›
      </button>
    </div>
  );
}
