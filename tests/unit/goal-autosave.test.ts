import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutosaveQueue, type SaveFn, type SaveOutcome, type SaveRequest } from "@/lib/goals/autosave";
import { goalFieldProblem, isGoalPatchField } from "@/lib/goals/goal-patch";
import { notSavedMessage, saveStatusText } from "@/lib/goals/save-status";

/** A fake server: records each save and answers when told to. */
function fakeServer() {
  const calls: SaveRequest[] = [];
  const waiting: ((r: SaveOutcome) => void)[] = [];
  let n = 0;
  const save: SaveFn = (req) => {
    calls.push(req);
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

const initial = {
  objective: "[Client] will mand.",
  rationale: "Because.",
  masteryAccuracyPct: 80,
  barriers: "",
  introducedAt: "2026-09-01" as string | null,
  projectedMasteryDate: "2027-01-01" as string | null,
};
const V0 = "2026-10-30T12:00:00.000Z";
const DIALOG = ["objective", "rationale", "masteryAccuracyPct"];
const RECORD = ["barriers", "introducedAt", "projectedMasteryDate"];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);
const newQueue = (
  s: ReturnType<typeof fakeServer>,
  more: Partial<ConstructorParameters<typeof AutosaveQueue>[0]> = {},
) => new AutosaveQueue({ save: s.save, initial, version: V0, validate, ...more });

/** Flush and answer each save until it settles. */
async function flushWith(s: ReturnType<typeof fakeServer>, q: AutosaveQueue) {
  const done = q.flush();
  for (let i = 0; i < 5; i++) {
    await settle();
    if (s.waiting.length) s.answer();
  }
  return done;
}

describe("goal autosave queue", () => {
  it("waits until typing stops (800 ms), then sends only the changed fields once, with what they were based on", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("objective", "[Client] will m");
    await vi.advanceTimersByTimeAsync(500);
    q.set("objective", "[Client] will mand for items.");
    await vi.advanceTimersByTimeAsync(799);
    expect(s.calls).toHaveLength(0);
    expect(saveStatusText(q.getState(), DIALOG).text).toBe("Saving…");
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toEqual([
      {
        patch: { objective: "[Client] will mand for items." },
        base: { objective: initial.objective },
        keepalive: false,
      },
    ]);
    expect(q.getState().saving).toBe(true);
    s.answer();
    await settle();
    expect(saveStatusText(q.getState(), DIALOG).text).toBe("Saved");
    expect(q.getState().version).toBe("2026-10-30T12:00:01.000Z");
    expect(q.isClean()).toBe(true);
  });

  it("sends nothing when the value goes back to what is saved", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("rationale", "Because!");
    q.set("rationale", "Because.");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(0);
    expect(await q.flush()).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  it("never overlaps saves: edits made during a save go in the next one, based on the first", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("objective", "First edit.");
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls).toHaveLength(1);
    q.set("objective", "Second edit.");
    q.set("masteryAccuracyPct", 90);
    // A reopened editor shows the newest text.
    expect(q.current("objective", "")).toBe("Second edit.");
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls).toHaveLength(1);
    s.answer();
    await settle();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]).toEqual({
      patch: { objective: "Second edit.", masteryAccuracyPct: 90 },
      base: { objective: "First edit.", masteryAccuracyPct: 80 },
      keepalive: false,
    });
    s.answer();
    await settle();
    expect(q.isClean()).toBe(true);
  });

  it("shows a reopened editor the value of a save in flight", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("objective", "In flight.");
    await vi.advanceTimersByTimeAsync(800);
    expect(q.current("objective", "")).toBe("In flight.");
    expect(q.hasLocalEdit("objective")).toBe(true);
    s.answer();
    await settle();
    expect(q.hasLocalEdit("objective")).toBe(false);
  });

  it("flush sends at once and resolves when everything is saved", async () => {
    const s = fakeServer();
    const q = newQueue(s);
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
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(1);
  });

  it("flush waits for a save in flight and then sends what was typed meanwhile", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("objective", "One.");
    await vi.advanceTimersByTimeAsync(800);
    q.set("rationale", "Two.");
    const done = q.flush();
    await settle();
    expect(s.calls).toHaveLength(1);
    s.answer();
    await settle();
    expect(s.calls[1]).toMatchObject({ patch: { rationale: "Two." }, base: { rationale: "Because." } });
    s.answer();
    expect(await done).toBe(true);
  });

  it("never sends a value the server would refuse; the status says so instead of “Saved”", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    // A save first, so the status was "Saved".
    q.set("rationale", "Saved first.");
    await vi.advanceTimersByTimeAsync(800);
    s.answer();
    await settle();
    expect(saveStatusText(q.getState(), DIALOG).text).toBe("Saved");
    q.set("objective", "   ");
    q.set("masteryAccuracyPct", 150);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.calls).toHaveLength(1);
    expect(q.getState().problems).toEqual({
      objective: "Write the objective",
      masteryAccuracyPct: "The mastery percentage must be 100 or less",
    });
    expect(saveStatusText(q.getState(), DIALOG)).toEqual({
      text: "Not saved: fix the highlighted field.",
      bad: true,
    });
    // The goal's other editors name the field and where to fix it.
    expect(saveStatusText(q.getState(), RECORD)).toEqual({
      text: "Not saved yet: Objective and Mastery % (Edit goal, in the goal's menu).",
      bad: true,
    });
    expect(await q.flush()).toBe(false);
    expect(notSavedMessage(q.getState())).toBe(
      "Objective and Mastery % (Edit goal, in the goal's menu) could not be saved yet. Nothing you typed was lost; fix them and try again.",
    );
    // A reopened editor still shows what was typed.
    expect(q.current("objective", "x")).toBe("   ");
    q.set("objective", "Fixed.");
    q.set("masteryAccuracyPct", 85);
    expect(q.getState().problems).toEqual({});
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls[1]!.patch).toEqual({ objective: "Fixed.", masteryAccuracyPct: 85 });
  });

  it("keeps a failed save, shows the server's error by its fields, and sends it again with the next save", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("projectedMasteryDate", "2026-08-01");
    await vi.advanceTimersByTimeAsync(800);
    s.answer({ ok: false, error: "Projected mastery cannot be before the date introduced" });
    await settle();
    expect(q.getState()).toMatchObject({
      error: "Projected mastery cannot be before the date introduced",
      failedFields: ["projectedMasteryDate"],
    });
    expect(saveStatusText(q.getState(), RECORD).text).toBe("Not saved");
    expect(q.hasUnsaved()).toBe(true);
    // Fixing the other date sends both together.
    q.set("introducedAt", "2026-07-01");
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls[1]!.patch).toEqual({ introducedAt: "2026-07-01", projectedMasteryDate: "2026-08-01" });
    s.answer();
    await settle();
    expect(q.isClean()).toBe(true);
    expect(q.getState().error).toBeNull();
  });

  it("after a refused save is undone, nothing is left unsaved and actions are not blocked", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("projectedMasteryDate", "2026-08-01");
    await vi.advanceTimersByTimeAsync(800);
    s.answer({ ok: false, error: "Projected mastery cannot be before the date introduced" });
    await settle();
    // Back to the stored date.
    q.set("projectedMasteryDate", "2027-01-01");
    expect(q.getState()).toMatchObject({ failedFields: [], error: null });
    expect(saveStatusText(q.getState(), RECORD).bad).toBe(false);
    expect(await q.flush()).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it("on a conflict keeps what was typed, re-sends the other fields, and lets the person choose", async () => {
    const s = fakeServer();
    const onConflict = vi.fn();
    const q = newQueue(s, { onConflict });
    q.set("objective", "Mine.");
    q.set("barriers", "Mine too.");
    await vi.advanceTimersByTimeAsync(800);
    s.answer({
      ok: false,
      error: "Someone changed this somewhere else",
      conflict: {
        fields: ["objective"],
        current: { objective: "Theirs.", barriers: "" },
        updatedAt: "2026-10-30T13:00:00.000Z",
      },
    });
    await settle();
    expect(onConflict).toHaveBeenCalledOnce();
    expect(q.getState().conflicts).toEqual({ objective: "Theirs." });
    // Nothing typed is dropped: the editor still shows it.
    expect(q.current("objective", "")).toBe("Mine.");
    expect(saveStatusText(q.getState(), DIALOG).bad).toBe(true);
    // Typed while the conflict is shown: kept, not sent.
    q.set("objective", "Mine, longer.");
    expect(q.current("objective", "")).toBe("Mine, longer.");
    // The field nobody else changed goes again by itself.
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls[1]).toMatchObject({ patch: { barriers: "Mine too." }, base: { barriers: "" } });
    s.answer();
    await settle();
    expect(await q.flush()).toBe(false);
    expect(notSavedMessage(q.getState())).toMatch(
      /^Objective \(Edit goal, in the goal's menu\) could not be saved/,
    );
    // Keep mine: saved over the other version.
    q.resolve("objective", "mine");
    expect(q.getState().conflicts).toEqual({});
    expect(await flushWith(s, q)).toBe(true);
    expect(s.calls[2]).toMatchObject({
      patch: { objective: "Mine, longer." },
      base: { objective: "Theirs." },
    });
  });

  it("taking the other version shows it and leaves nothing unsaved", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("rationale", "Mine.");
    await vi.advanceTimersByTimeAsync(800);
    s.answer({
      ok: false,
      error: "x",
      conflict: { fields: ["rationale"], current: { rationale: "Theirs." } },
    });
    await settle();
    q.resolve("rationale", "theirs");
    expect(q.current("rationale", "")).toBe("Theirs.");
    expect(await q.flush()).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it("a queue from an earlier visit takes the page's newer values, so it never saves against stale ones", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    // Back on the page: the goal is newer (attached to a plan), and its rationale changed elsewhere.
    expect(q.adopt("2026-10-30T13:00:00.000Z", { ...initial, rationale: "Changed in another tab." })).toEqual(
      ["rationale"],
    );
    q.set("barriers", "Typed.");
    await vi.advanceTimersByTimeAsync(800);
    expect(s.calls[0]).toMatchObject({ patch: { barriers: "Typed." }, base: { barriers: "" } });
    expect(q.savedValue("rationale")).toBe("Changed in another tab.");
  });

  it("takes a newer server record for fields with nothing typed, and never an older one", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("barriers", "Typing.");
    // Discontinued meanwhile: the status is taken, the barriers being typed are not.
    expect(q.adopt("2026-10-30T13:00:00.000Z", { barriers: "", progressStatus: "discontinued" })).toEqual([
      "progressStatus",
    ]);
    expect(q.current("barriers", "")).toBe("Typing.");
    const done = q.flush();
    await settle();
    s.answer({ ok: true, updatedAt: "2026-10-30T14:00:00.000Z" });
    await done;
    expect(q.adopt("2026-10-30T11:00:00.000Z", { progressStatus: "in_progress" })).toEqual([]);
    expect(q.savedValue("progressStatus")).toBe("discontinued");
    // The same version as the last save (the page reloading after it) is taken.
    expect(q.adopt("2026-10-30T14:00:00.000Z", { barriers: "Typing.", objective: "Server." })).toEqual([
      "objective",
    ]);
    q.adoptVersion("2026-10-30T15:00:00.000Z");
    expect(q.getState().version).toBe("2026-10-30T15:00:00.000Z");
  });

  it("leaving the page with a save in flight sends everything at once, without waiting", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("objective", "A sentence.");
    await vi.advanceTimersByTimeAsync(800);
    q.set("objective", "A sentence. More words.");
    q.set("barriers", "And barriers.");
    q.leave();
    await settle();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]).toEqual({
      patch: { objective: "A sentence. More words.", barriers: "And barriers." },
      base: { objective: initial.objective, barriers: "" },
      // The save in flight may land first.
      baseAlt: { objective: "A sentence." },
      keepalive: true,
    });
    // The leaving save lands first; the earlier one landing after it does not undo it here.
    s.waiting.reverse();
    s.answer({ ok: true, updatedAt: "2026-10-30T12:00:05.000Z" });
    s.answer({ ok: true, updatedAt: "2026-10-30T12:00:04.000Z" });
    await settle();
    expect(q.savedValue("objective")).toBe("A sentence. More words.");
    expect(q.isClean()).toBe(true);
  });

  it("leaving the page with nothing in flight sends at once with keepalive", async () => {
    const s = fakeServer();
    const q = newQueue(s);
    q.set("rationale", "Last words.");
    q.leave();
    await settle();
    expect(s.calls[0]).toMatchObject({ patch: { rationale: "Last words." }, keepalive: true });
  });

  it("discard drops unsent edits (the goal is being removed)", async () => {
    const s = fakeServer();
    const q = newQueue(s);
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
    expect(q.getState().failedFields).toEqual(["objective"]);
    expect(q.current("objective", "")).toBe("Offline edit.");
    expect(q.hasUnsaved()).toBe(true);
  });
});
