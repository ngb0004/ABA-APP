/**
 * Autosave for one goal's editors (the BCBA's decision: save as someone types; nothing typed is
 * lost unless they choose to remove the goal).
 *
 * Edits are collected per field and sent about 800 ms after typing stops (or at once on flush:
 * blur, closing the editor, leaving the page, or before Discontinue, Resume, Remove, or Approve).
 * Saves for a goal never overlap: while one is in flight, newer edits wait and go in the next one,
 * so the server sees them in order. Each save carries the version it was based on; a goal changed
 * somewhere else is refused (conflict) rather than overwritten. A value that fails the same checks
 * the server applies is never sent; its problem is shown instead.
 *
 * Pure logic: the network call and timers are injected, so it runs (and is tested) without a browser.
 */

export type SaveOutcome =
  | { ok: true; updatedAt: string; returnedToDraft?: boolean }
  | { ok: false; conflict?: boolean; error: string };

export type SaveFn = (
  patch: Record<string, unknown>,
  expectedUpdatedAt: string,
  opts: { keepalive: boolean },
) => Promise<SaveOutcome>;

export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";

export type AutosaveState = {
  status: AutosaveStatus;
  /** The server's message for the last failed save (or the conflict). */
  error: string | null;
  /** Fields whose last save failed: the error is shown next to them. */
  failedFields: string[];
  /** Values that were not sent because they would be refused, by field. */
  problems: Record<string, string>;
  /** The last save sent an approved goal back to draft. */
  returnedToDraft: boolean;
  /** The goal's version (updatedAt) the next save is based on. */
  version: string;
};

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export const AUTOSAVE_DELAY_MS = 800;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class AutosaveQueue {
  private saved: Record<string, unknown>;
  private pending: Record<string, unknown> = {};
  /** The last patch that failed (not a conflict): retried once by the next flush. */
  private failed: Record<string, unknown> = {};
  private timer: unknown = null;
  /** A save was refused as stale: the next server record is taken whatever its version. */
  private awaitingReload = false;
  private keepalive = false;
  /** The last server version taken by adopt (other editors of the goal take it too). */
  private adoptedVersion = "";
  /** Edits held back as invalid, so a reopened editor still shows them. */
  private held: Record<string, unknown> = {};
  private running: Promise<void> | null = null;
  private listeners = new Set<(s: AutosaveState) => void>();
  private state: AutosaveState;

  constructor(
    private opts: {
      save: SaveFn;
      /** The goal's stored values and version when the editor opened. */
      initial: Record<string, unknown>;
      version: string;
      /** The problem with a value, or null when it can be saved. */
      validate?: (field: string, value: unknown) => string | null;
      /** Called after a refused save (the goal changed elsewhere): reload the latest version. */
      onConflict?: () => void;
      /** Called after each successful save. */
      onSaved?: () => void;
      delayMs?: number;
      timers?: Timers;
    },
  ) {
    this.saved = { ...opts.initial };
    this.state = {
      status: "idle",
      error: null,
      failedFields: [],
      problems: {},
      returnedToDraft: false,
      version: opts.version,
    };
  }

  private get timers(): Timers {
    return (
      this.opts.timers ?? {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }
    );
  }

  getState(): AutosaveState {
    return this.state;
  }

  /** The value last saved (or loaded) for a field. */
  savedValue(field: string): unknown {
    return this.saved[field];
  }

  subscribe(fn: (s: AutosaveState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<AutosaveState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Unsent edits, or a save in flight. */
  hasUnsaved(): boolean {
    return !!this.running || Object.keys(this.pending).length > 0 || Object.keys(this.failed).length > 0;
  }

  /** Record an edit. It is sent after the debounce delay, unless it would be refused. */
  set(field: string, value: unknown) {
    const problem = this.opts.validate?.(field, value) ?? null;
    const problems = { ...this.state.problems };
    delete this.failed[field];
    if (problem) {
      problems[field] = problem;
      this.held[field] = value;
      delete this.pending[field];
    } else {
      delete problems[field];
      delete this.held[field];
      if (same(this.saved[field], value)) delete this.pending[field];
      else this.pending[field] = value;
    }
    const failedFields = this.state.failedFields.filter((f) => f !== field);
    const waiting = Object.keys(this.pending).length > 0;
    this.emit({
      problems,
      failedFields,
      ...(waiting && !this.running ? { status: "pending" as const } : {}),
    });
    this.restartTimer(waiting);
  }

  private restartTimer(start: boolean) {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (start)
      this.timer = this.timers.set(() => {
        this.timer = null;
        void this.drain({ keepalive: false });
      }, this.opts.delayMs ?? AUTOSAVE_DELAY_MS);
  }

  /**
   * Send everything waiting now and wait for it. True when every edit is saved and none is being
   * held back as invalid; false otherwise (the state says why).
   */
  async flush(opts: { keepalive?: boolean } = {}): Promise<boolean> {
    this.restartTimer(false);
    // A save that failed is tried once more, so a passing network blip does not lose an edit.
    for (const [k, v] of Object.entries(this.failed)) if (!(k in this.pending)) this.pending[k] = v;
    this.failed = {};
    await this.drain({ keepalive: !!opts.keepalive });
    return (
      !this.hasUnsaved() &&
      Object.keys(this.state.problems).length === 0 &&
      this.state.status !== "error" &&
      this.state.status !== "conflict"
    );
  }

  /** Drop edits not yet sent (the goal is being removed). */
  discard() {
    this.restartTimer(false);
    this.pending = {};
    this.failed = {};
    this.held = {};
    this.emit({ problems: {}, failedFields: [], status: this.running ? "saving" : "idle" });
  }

  /**
   * The server's record changed (after a reload, or an action like Discontinue): take its values
   * for the given fields, unless edits are waiting (they would be lost). True when taken, so the
   * editor shows them. Several editors of one goal each call this with their own fields.
   */
  adopt(version: string, values: Record<string, unknown>): boolean {
    const reload = this.awaitingReload;
    if (!reload) {
      if (this.hasUnsaved()) return false;
      if (version !== this.adoptedVersion && version <= this.state.version) return false;
    }
    this.awaitingReload = false;
    this.adoptedVersion = version;
    Object.assign(this.saved, values);
    if (reload) {
      this.pending = {};
      this.failed = {};
      this.held = {};
    }
    // After a conflict the message stays up ("the latest version is shown") until the next edit.
    this.emit({
      version: version > this.state.version || reload ? version : this.state.version,
      failedFields: [],
      problems: reload ? {} : this.state.problems,
    });
    return true;
  }

  /** Take a newer version after an action that changed no field being edited (Discontinue, Approve). */
  adoptVersion(version: string) {
    if (version <= this.state.version) return;
    this.adoptedVersion = version;
    this.emit({ version });
  }

  /** What an editor should show for a field: an unsent or held-back edit, else the saved value. */
  current(field: string, fallback: unknown): unknown {
    for (const m of [this.held, this.pending, this.failed]) if (field in m) return m[field];
    return field in this.saved ? this.saved[field] : fallback;
  }

  /** Add stored values for fields this queue has not seen yet (a second editor opening). */
  seed(values: Record<string, unknown>) {
    for (const [k, v] of Object.entries(values)) if (!(k in this.saved)) this.saved[k] = v;
  }

  private drain(opts: { keepalive: boolean }): Promise<void> {
    // Leaving the page: every save from now until the queue is empty must outlive it.
    if (opts.keepalive) this.keepalive = true;
    if (this.running) {
      // One save at a time: the edits wait for the save in flight, then go in the next one.
      const after = this.running.then(() => this.drain(opts));
      return after;
    }
    if (!Object.keys(this.pending).length) return Promise.resolve();
    const run = this.loop().finally(() => {
      this.running = null;
      this.keepalive = false;
    });
    this.running = run;
    return run;
  }

  private async loop() {
    // A refused save waits for the latest version before anything else is sent.
    if (this.awaitingReload) return;
    while (Object.keys(this.pending).length) {
      const patch = Object.fromEntries(
        Object.entries(this.pending).filter(([k, v]) => !same(this.saved[k], v)),
      );
      this.pending = {};
      if (!Object.keys(patch).length) break;
      this.emit({ status: "saving", error: null });
      let r: SaveOutcome;
      try {
        r = await this.opts.save(patch, this.state.version, { keepalive: this.keepalive });
      } catch {
        r = { ok: false, error: "Could not reach the server. Your change will be saved when you try again." };
      }
      if (r.ok) {
        Object.assign(this.saved, patch);
        this.emit({
          version: r.updatedAt,
          status: Object.keys(this.pending).length ? "pending" : "saved",
          error: null,
          returnedToDraft: !!r.returnedToDraft,
        });
        this.opts.onSaved?.();
        continue;
      }
      if (r.conflict) {
        // The goal changed elsewhere: nothing more is sent until the latest version is loaded.
        this.pending = {};
        this.failed = {};
        this.awaitingReload = true;
        this.emit({ status: "conflict", error: r.error, failedFields: [] });
        this.opts.onConflict?.();
        return;
      }
      this.failed = { ...patch, ...this.failed };
      this.emit({ status: "error", error: r.error, failedFields: Object.keys(patch) });
      return;
    }
    if (this.state.status === "saving" || this.state.status === "pending")
      this.emit({ status: Object.keys(this.state.problems).length ? "idle" : "saved" });
  }
}
