import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutosaveQueue, type SaveFn, type SaveOutcome } from "@/lib/goals/autosave";
import { goalFieldProblem, isGoalPatchField } from "@/lib/goals/goal-patch";

type Call = { patch: Record<string, unknown>; version: string; keepalive: boolean };

/** A fake server: records each save and answers when told to. */
function fakeServer() {
  const calls: Call[] = [];
  const waiting: ((r: SaveOutcome) => void)[] = [];
  let n = 0;
  const save: SaveFn = (patch, version, { keepalive }) => {
    calls.push({ patch, version, keepalive });
    return new Promise((res) => waiting.push(res));
  };
  const answer = (r?: SaveOutcome) => {
    const res = waiting.shift();
    if (!res) throw new Error("no save waiting");
    res(r ?? { ok: true, updatedAt: `2026-10-30T12:00:0${++n}.000Z` });
  };
  return { calls, save, answer, waiting };
}

const validate = (field: string, value: unknown) =>
  isGoalPatchField(field) ? goalFieldProblem(field, value) : null;

const initial = { objective: "[Client] will mand.", rationale: "Because.", masteryAccuracyPct: 80 };
const V0 = "2026-10-30T12:00:00.000Z";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("goal autosave queue", () => {
  it("waits until typing stops (800 ms), then sends only the changed fields once", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "[Client] will m");
    await vi.advanceTimersByTimeAsync(500);
    q.set("objective", "[Client] will mand for items.");
    await vi.advanceTimersByTimeAsync(799);
    expect(s.calls).toHaveLength(0);
    expect(q.getState().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toEqual([
      { patch: { objective: "[Client] will mand for items." }, version: V0, keepalive: false },
    ]);
    expect(q.getState().status).toBe("saving");
    s.answer();
    await settle();
    expect(q.getState().status).toBe("saved");
    expect(q.getState().version).toBe("2026-10-30T12:00:01.000Z");
    expect(q.hasUnsaved()).toBe(false);
  });

  it("sends nothing when the value goes back to what is saved", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("rationale", "Because!");
    q.set("rationale", "Because.");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(0);
    expect(await q.flush()).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  it("never overlaps saves: edits made during a save go in the next one, with the new version", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "First edit.");
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls).toHaveLength(1);
    q.set("objective", "Second edit.");
    q.set("masteryAccuracyPct", 90);
    await vi.advanceTimersByTimeAsync(800);
    // Still one in flight: the second waits.
    expect(s.calls).toHaveLength(1);
    s.answer();
    await settle();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]).toEqual({
      patch: { objective: "Second edit.", masteryAccuracyPct: 90 },
      version: "2026-10-30T12:00:01.000Z",
      keepalive: false,
    });
    s.answer();
    await settle();
    expect(q.getState().status).toBe("saved");
  });

  it("flush sends at once and resolves when everything is saved", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "Typed then Discontinue.");
    const done = q.flush();
    await settle();
    expect(s.calls).toHaveLength(1);
    let result: boolean | undefined;
    void done.then((r) => (result = r));
    await settle();
    expect(result).toBeUndefined();
    s.answer();
    await settle();
    expect(result).toBe(true);
    // The debounce timer was cancelled: nothing is sent again.
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(1);
  });

  it("flush waits for a save in flight and then sends what was typed meanwhile", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "One.");
    await vi.advanceTimersByTimeAsync(800);
    q.set("rationale", "Two.");
    const done = q.flush({ keepalive: true });
    await settle();
    expect(s.calls).toHaveLength(1);
    s.answer();
    await settle();
    expect(s.calls[1]).toMatchObject({ patch: { rationale: "Two." }, keepalive: true });
    s.answer();
    expect(await done).toBe(true);
  });

  it("never sends a value the server would refuse, and shows the problem instead", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "   ");
    q.set("masteryAccuracyPct", 150);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(0);
    expect(q.getState().problems).toEqual({
      objective: "Write the objective",
      masteryAccuracyPct: "The mastery percentage must be 100 or less",
    });
    expect(await q.flush()).toBe(false);
    q.set("objective", "Fixed.");
    q.set("masteryAccuracyPct", 85);
    expect(q.getState().problems).toEqual({});
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls[0]!.patch).toEqual({ objective: "Fixed.", masteryAccuracyPct: 85 });
  });

  it("keeps a failed save, shows the server's error by its fields, and retries it on flush", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "Will fail.");
    await vi.advanceTimersByTimeAsync(800);
    s.answer({ ok: false, error: "Projected mastery cannot be before the date introduced" });
    await settle();
    expect(q.getState()).toMatchObject({
      status: "error",
      error: "Projected mastery cannot be before the date introduced",
      failedFields: ["objective"],
    });
    expect(q.hasUnsaved()).toBe(true);
    const done = q.flush();
    await settle();
    expect(s.calls[1]!.patch).toEqual({ objective: "Will fail." });
    s.answer();
    expect(await done).toBe(true);
  });

  it("on a conflict stops sending, asks for the latest version, and takes it", async () => {
    const s = fakeServer();
    const onConflict = vi.fn();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate, onConflict });
    q.set("objective", "Mine.");
    await vi.advanceTimersByTimeAsync(800);
    s.answer({ ok: false, conflict: true, error: "This goal was changed somewhere else" });
    await settle();
    expect(onConflict).toHaveBeenCalledOnce();
    expect(q.getState().status).toBe("conflict");
    // Typed before the reload arrives: held, not sent against the stale version.
    q.set("rationale", "Held.");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(1);
    expect(q.adopt("2026-10-30T13:00:00.000Z", { ...initial, objective: "Theirs." })).toBe(true);
    expect(q.savedValue("objective")).toBe("Theirs.");
    q.set("objective", "Again.");
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls[1]).toMatchObject({ patch: { objective: "Again." }, version: "2026-10-30T13:00:00.000Z" });
  });

  it("takes a newer server record only when nothing is waiting", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    expect(q.adopt(V0, initial)).toBe(false);
    q.set("objective", "Typing.");
    expect(q.adopt("2026-10-30T13:00:00.000Z", initial)).toBe(false);
    const done = q.flush();
    await settle();
    s.answer();
    await done;
    expect(q.adopt("2026-10-30T11:00:00.000Z", initial)).toBe(false);
    expect(q.adopt("2026-10-30T13:00:00.000Z", { ...initial, objective: "Server." })).toBe(true);
    q.adoptVersion("2026-10-30T14:00:00.000Z");
    expect(q.getState().version).toBe("2026-10-30T14:00:00.000Z");
    // The page then reloads with that version: each editor of the goal takes its fields.
    expect(q.adopt("2026-10-30T14:00:00.000Z", { progressStatus: "discontinued" })).toBe(true);
    expect(q.adopt("2026-10-30T14:00:00.000Z", { objective: "Server." })).toBe(true);
    expect(q.savedValue("progressStatus")).toBe("discontinued");
  });

  it("shows a reopened editor what was typed, including a value held back as invalid", () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "");
    q.set("rationale", "Typed.");
    expect(q.current("objective", "x")).toBe("");
    expect(q.current("rationale", "x")).toBe("Typed.");
    expect(q.current("barriers", "fallback")).toBe("fallback");
    q.seed({ barriers: "Stored.", objective: "ignored" });
    expect(q.current("barriers", "fallback")).toBe("Stored.");
    expect(q.savedValue("objective")).toBe(initial.objective);
  });

  it("discard drops unsent edits (the goal is being removed)", async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ save: s.save, initial, version: V0, validate });
    q.set("objective", "Gone.");
    q.discard();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(0);
    expect(q.hasUnsaved()).toBe(false);
  });

  it("treats a network failure as a failed save, kept for the next try", async () => {
    const q = new AutosaveQueue({
      save: () => Promise.reject(new Error("offline")),
      initial,
      version: V0,
      validate,
    });
    q.set("objective", "Offline edit.");
    expect(await q.flush()).toBe(false);
    expect(q.getState().status).toBe("error");
    expect(q.hasUnsaved()).toBe(true);
  });
});
