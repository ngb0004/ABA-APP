"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AutosaveQueue, type AutosaveState, type SaveOutcome } from "@/lib/goals/autosave";
import { goalFieldProblem, isGoalPatchField } from "@/lib/goals/goal-patch";

/**
 * One autosave queue per goal, shared by every editor of that goal on the page (the goal dialog,
 * the goal record, the flat-progress note), so their saves go one at a time against one version.
 */
const queues = new Map<string, AutosaveQueue>();
/** The latest router refresh, so a save made after an editor closed still updates the page. */
let refreshPage: (() => void) | null = null;

async function saveGoal(
  goalId: string,
  patch: Record<string, unknown>,
  expectedUpdatedAt: string,
  keepalive: boolean,
): Promise<SaveOutcome> {
  const res = await fetch(`/api/goals/${goalId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...patch, expectedUpdatedAt }),
    // Leaving the page: the save must outlive it (sendBeacon cannot PATCH).
    keepalive,
  });
  const data = (res.headers.get("content-type")?.includes("json") ? await res.json() : {}) as Record<
    string,
    unknown
  >;
  if (res.ok)
    return {
      ok: true,
      updatedAt: String(data.updatedAt),
      returnedToDraft: data.returnedToDraft === true,
    };
  const issues = Array.isArray(data.issues) ? (data.issues as string[]) : [];
  return {
    ok: false,
    conflict: res.status === 409,
    error: [String(data.error ?? "Could not save"), ...issues].join(" "),
  };
}

function flushAllOnLeave() {
  for (const q of queues.values()) if (q.hasUnsaved()) void q.flush({ keepalive: true });
}

let leaveHandlersInstalled = false;
function installLeaveHandlers() {
  if (leaveHandlersInstalled || typeof window === "undefined") return;
  leaveHandlersInstalled = true;
  window.addEventListener("pagehide", flushAllOnLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAllOnLeave();
  });
}

export function goalQueue(goalId: string, version: string, values: Record<string, unknown>): AutosaveQueue {
  let q = queues.get(goalId);
  if (!q) {
    q = new AutosaveQueue({
      initial: values,
      version,
      save: (patch, expected, { keepalive }) => saveGoal(goalId, patch, expected, keepalive),
      validate: (field, value) => (isGoalPatchField(field) ? goalFieldProblem(field, value) : null),
      onSaved: () => refreshPage?.(),
      onConflict: () => refreshPage?.(),
    });
    queues.set(goalId, q);
  } else q.seed(values);
  installLeaveHandlers();
  return q;
}

/**
 * Save anything typed for this goal before an action on it (Discontinue, Resume, Remove,
 * Approve). False when something could not be saved; the editor shows why.
 */
export async function flushGoal(goalId: string): Promise<boolean> {
  const q = queues.get(goalId);
  return q ? q.flush() : true;
}

/** After an action that changed the goal's version but none of its editable text. */
export function goalVersionChanged(goalId: string, updatedAt: unknown) {
  if (typeof updatedAt === "string") queues.get(goalId)?.adoptVersion(updatedAt);
}

/** The goal is gone: drop its queue (and anything unsent, which the person chose to remove). */
export function forgetGoal(goalId: string) {
  queues.get(goalId)?.discard();
  queues.delete(goalId);
}

/**
 * Autosaving fields for one goal editor. `server` is the goal's stored values for this editor's
 * fields; `version` is the goal's updatedAt. Returns what to show and a setter that queues a save.
 */
export function useGoalAutosave<T extends Record<string, unknown>>(
  goalId: string,
  version: string,
  server: T,
) {
  const router = useRouter();
  useEffect(() => {
    refreshPage = router.refresh;
  }, [router]);
  const q = goalQueue(goalId, version, server);
  const [values, setValues] = useState<T>(
    () => Object.fromEntries(Object.entries(server).map(([k, v]) => [k, q.current(k, v)])) as T,
  );
  const state: AutosaveState = useSyncExternalStore(
    (fn) => q.subscribe(fn),
    () => q.getState(),
    () => q.getState(),
  );
  /** Counts records taken from the server, for fields an editor shows differently from how they are saved. */
  const [revision, setRevision] = useState(0);
  const serverRef = useRef(server);
  serverRef.current = server;
  const mounted = useRef(false);
  useEffect(() => {
    // A newer record from the server (a reload after a conflict, Discontinue, another tab's save):
    // show it, unless something typed here is still waiting.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (q.adopt(version, serverRef.current)) {
      setValues({ ...serverRef.current });
      setRevision((r) => r + 1);
    }
  }, [q, version]);
  // Closing the editor sends what was typed at once (the queue outlives the editor anyway).
  useEffect(() => () => void q.flush(), [q]);
  return {
    values,
    state,
    revision,
    /** Show a value and queue it for saving (as `saved` when what is stored differs from the text shown). */
    set<K extends keyof T & string>(field: K, value: T[K], saved: unknown = value) {
      setValues((v) => ({ ...v, [field]: value }));
      q.set(field, saved);
    },
    flush: () => q.flush(),
  };
}
