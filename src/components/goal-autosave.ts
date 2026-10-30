"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AutosaveQueue,
  same,
  type AutosaveState,
  type SaveOutcome,
  type SaveRequest,
} from "@/lib/goals/autosave";
import { goalFieldProblem, isGoalPatchField } from "@/lib/goals/goal-patch";
import { notSavedMessage } from "@/lib/goals/save-status";

/**
 * One autosave queue per goal, shared by every editor of that goal on the page (the goal dialog,
 * the goal record, the flat-progress note), so their saves go one at a time. A queue is dropped
 * once its last editor closes and everything typed is saved, so a later visit starts fresh.
 */
const queues = new Map<string, AutosaveQueue>();
/** Open editors per goal. */
const editors = new Map<string, number>();
/** The latest router refresh, so a save made after an editor closed still updates the page. */
let refreshPage: (() => void) | null = null;

async function saveGoal(goalId: string, req: SaveRequest): Promise<SaveOutcome> {
  const res = await fetch(`/api/goals/${goalId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...req.patch, base: req.base, ...(req.baseAlt ? { baseAlt: req.baseAlt } : {}) }),
    // Leaving the page: the save must outlive it (sendBeacon cannot PATCH).
    keepalive: req.keepalive,
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
  const c = data.conflict as { fields?: unknown; current?: unknown; updatedAt?: unknown } | undefined;
  const conflict =
    res.status === 409 && c && Array.isArray(c.fields) && c.current && typeof c.current === "object"
      ? {
          fields: c.fields.map(String),
          current: c.current as Record<string, unknown>,
          ...(typeof c.updatedAt === "string" ? { updatedAt: c.updatedAt } : {}),
        }
      : undefined;
  return {
    ok: false,
    ...(conflict ? { conflict } : {}),
    error: [String(data.error ?? "Could not save"), ...issues].join(" "),
  };
}

function flushAllOnLeave() {
  for (const q of queues.values()) if (q.hasUnsaved()) q.leave();
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
      save: (req) => saveGoal(goalId, req),
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
 * Approve, Lock baseline). Null when everything is saved; otherwise why not, naming the fields
 * and where they are edited.
 */
export async function flushGoal(goalId: string): Promise<string | null> {
  const q = queues.get(goalId);
  if (!q || (await q.flush())) return null;
  return notSavedMessage(q.getState());
}

/**
 * What the approver is looking at, for Approve: the page's values, with this tab's saved values
 * for fields its editors know (they can be newer than the page until it reloads).
 */
export function goalShownValues<T extends Record<string, unknown>>(goalId: string, page: T): T {
  const q = queues.get(goalId);
  if (!q) return page;
  return Object.fromEntries(Object.entries(page).map(([k, v]) => [k, q.knows(k) ? q.savedValue(k) : v])) as T;
}

/** After an action that changed the goal's version but none of its editable text. */
export function goalVersionChanged(goalId: string, updatedAt: unknown) {
  if (typeof updatedAt === "string") queues.get(goalId)?.adoptVersion(updatedAt);
}

/** The goal is gone: drop its queue (and anything unsent, which the person chose to remove). */
export function forgetGoal(goalId: string) {
  queues.get(goalId)?.discard();
  queues.delete(goalId);
  editors.delete(goalId);
}

/** An editor of the goal closed: send what was typed, and drop the queue once nothing is open or unsaved. */
function release(goalId: string, q: AutosaveQueue) {
  editors.set(goalId, (editors.get(goalId) ?? 1) - 1);
  void q.flush().then(() => {
    if ((editors.get(goalId) ?? 0) <= 0 && queues.get(goalId) === q && q.isClean()) {
      queues.delete(goalId);
      editors.delete(goalId);
    }
  });
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
  /** Show what the queue holds for these fields (a newer server record, or a choice just made). */
  const showQueue = (fields: string[]) => {
    const next: Record<string, unknown> = {};
    for (const k of fields) next[k] = q.current(k, undefined);
    setValues((v) => {
      const changed = fields.filter((k) => next[k] !== undefined && !same(next[k], v[k]));
      if (!changed.length) return v;
      return { ...v, ...Object.fromEntries(changed.map((k) => [k, next[k]])) } as T;
    });
    if (fields.some((k) => !same(next[k], values[k]))) setRevision((r) => r + 1);
  };
  useEffect(() => {
    // The page's copy of the goal (on opening, after a reload, Discontinue, another tab's save):
    // show its values for fields with nothing typed here. A queue left from an earlier visit to
    // the page takes them too, so it never saves against values it no longer has.
    q.adopt(version, serverRef.current);
    showQueue(Object.keys(serverRef.current).filter((k) => !q.hasLocalEdit(k)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, version]);
  useEffect(() => {
    editors.set(goalId, (editors.get(goalId) ?? 0) + 1);
    // Closing the editor sends what was typed at once (the queue outlives the editor anyway).
    return () => release(goalId, q);
  }, [goalId, q]);
  return {
    values,
    state,
    revision,
    /** Show a value and queue it for saving (as `saved` when what is stored differs from the text shown). */
    set<K extends keyof T & string>(field: K, value: T[K], saved: unknown = value) {
      setValues((v) => ({ ...v, [field]: value }));
      q.set(field, saved);
    },
    /** Settle a conflict on a field: keep what was typed here, or take the other version. */
    resolve(field: string, keep: "mine" | "theirs") {
      q.resolve(field, keep);
      if (keep === "theirs") showQueue([field]);
    },
    flush: () => q.flush(),
  };
}
