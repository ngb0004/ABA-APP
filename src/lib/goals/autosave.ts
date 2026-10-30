/**
 * Autosave for one goal's editors (the BCBA's decision: save as someone types; nothing typed is
 * lost unless they choose to remove the goal).
 *
 * Edits are collected per field and sent about 800 ms after typing stops (or at once on flush:
 * blur, closing the editor, or before Discontinue, Resume, Remove, Approve, or Lock baseline).
 * Saves for a goal never overlap while the page is open: newer edits wait for the save in flight
 * and go in the next one. Leaving the page does not wait: everything unsaved goes at once in one
 * request that outlives the page.
 *
 * Each save names, per field, the value it was based on. The server refuses a field only when
 * someone else changed that same field meanwhile; changes to other fields or to the goal's
 * bookkeeping (its position, plan, approval, baseline) are not conflicts. On a conflict nothing
 * typed is dropped: the person's text stays in the editor beside the other version until they
 * choose which to keep. A value that fails the same checks the server applies is never sent; its
 * problem is shown instead.
 *
 * Pure logic: the network call and timers are injected, so it runs (and is tested) without a browser.
 */

export type SaveRequest = {
  /** The new values, by field. */
  patch: Record<string, unknown>;
  /** What each field held when it was edited here: the server refuses a field that no longer holds it. */
  base: Record<string, unknown>;
  /** Also accepted as what a field holds: the value of a save still in flight when the page is left. */
  baseAlt?: Record<string, unknown>;
  /** The request must outlive the page. */
  keepalive: boolean;
};

export type SaveConflict = {
  /** Fields someone else changed meanwhile. */
  fields: string[];
  /** The goal's stored values for the fields sent. */
  current: Record<string, unknown>;
  updatedAt?: string;
};

export type SaveOutcome =
  | { ok: true; updatedAt: string; returnedToDraft?: boolean }
  | { ok: false; conflict?: SaveConflict; error: string };

export type SaveFn = (req: SaveRequest) => Promise<SaveOutcome>;

export type AutosaveState = {
  /** A save is in flight. */
  saving: boolean;
  /** Fields with an edit waiting to be sent or in flight. */
  pendingFields: string[];
  /** Fields whose last save failed; `error` says why. */
  failedFields: string[];
  /** The server's message for the failed fields (null when none failed). */
  error: string | null;
  /** Values not sent because they would be refused, by field. */
  problems: Record<string, string>;
  /**
   * Fields someone else changed while they were edited here: the other version, by field. The
   * person's own text stays in the editor until they choose.
   */
  conflicts: Record<string, unknown>;
  /** Fields saved since the page opened. */
  savedFields: string[];
  /** The last save sent an approved goal back to draft. */
  returnedToDraft: boolean;
  /** The newest version (updatedAt) of the goal this queue has seen. */
  version: string;
};

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export const AUTOSAVE_DELAY_MS = 800;

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const pick = (from: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, from[k]]));

const empty = (m: Record<string, unknown>) => Object.keys(m).length === 0;

export class AutosaveQueue {
  private saved: Record<string, unknown>;
  /** Valid edits not yet sent. */
  private pending: Record<string, unknown> = {};
  /** Edits whose save failed (not a conflict): sent again with the next save. */
  private failed: Record<string, unknown> = {};
  /** Edits held back as invalid, so a reopened editor still shows them. */
  private held: Record<string, unknown> = {};
  /** The person's text for fields in conflict, kept until they choose. */
  private mine: Record<string, unknown> = {};
  /** Saves in flight, by sequence number. */
  private inflight = new Map<number, Record<string, unknown>>();
  /** For each field, the sequence number of the save whose value `saved` holds. */
  private appliedSeq: Record<string, number> = {};
  private seq = 0;
  private timer: unknown = null;
  private keepalive = false;
  private running: Promise<void> | null = null;
  private listeners = new Set<(s: AutosaveState) => void>();
  private state: AutosaveState;
  private problems: Record<string, string> = {};
  private conflicts: Record<string, unknown> = {};
  private savedFields = new Set<string>();
  private error: string | null = null;

  constructor(
    private opts: {
      save: SaveFn;
      /** The goal's stored values and version when the editor opened. */
      initial: Record<string, unknown>;
      version: string;
      /** The problem with a value, or null when it can be saved. */
      validate?: (field: string, value: unknown) => string | null;
      /** Called after a save someone else's change refused: reload the page's copy. */
      onConflict?: () => void;
      /** Called after each successful save. */
      onSaved?: () => void;
      delayMs?: number;
      timers?: Timers;
    },
  ) {
    this.saved = { ...opts.initial };
    this.state = {
      saving: false,
      pendingFields: [],
      failedFields: [],
      error: null,
      problems: {},
      conflicts: {},
      savedFields: [],
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

  /** The queue has a stored value for the field (an editor of it has opened). */
  knows(field: string): boolean {
    return field in this.saved;
  }

  subscribe(fn: (s: AutosaveState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Publish the state, derived from what the queue holds (so it can never go stale). */
  private sync(patch: Partial<Pick<AutosaveState, "returnedToDraft" | "version">> = {}) {
    const inflightFields = new Set<string>();
    for (const p of this.inflight.values()) for (const k of Object.keys(p)) inflightFields.add(k);
    const failedFields = Object.keys(this.failed);
    if (!failedFields.length) this.error = null;
    this.state = {
      ...this.state,
      ...patch,
      saving: this.inflight.size > 0,
      pendingFields: [...new Set([...Object.keys(this.pending), ...inflightFields])],
      failedFields,
      error: this.error,
      problems: { ...this.problems },
      conflicts: { ...this.conflicts },
      savedFields: [...this.savedFields],
    };
    for (const l of this.listeners) l(this.state);
  }

  private inflightValue(field: string): { value: unknown } | null {
    let found: { seq: number; value: unknown } | null = null;
    for (const [seq, p] of this.inflight)
      if (field in p && (!found || seq > found.seq)) found = { seq, value: p[field] };
    return found;
  }

  /** What the server will hold for a field once the saves in flight land. */
  private basis(field: string): unknown {
    const f = this.inflightValue(field);
    return f ? f.value : this.saved[field];
  }

  /** The field has something typed here that is not saved yet (waiting, in flight, failed, held, or in conflict). */
  hasLocalEdit(field: string): boolean {
    return (
      field in this.pending ||
      field in this.failed ||
      field in this.held ||
      field in this.mine ||
      this.inflightValue(field) !== null
    );
  }

  /** Unsent edits, or a save in flight. */
  hasUnsaved(): boolean {
    return !!this.running || !empty(this.pending) || !empty(this.failed);
  }

  /** Everything typed is saved: nothing waiting, in flight, failed, held back, or in conflict. */
  isClean(): boolean {
    return (
      !this.hasUnsaved() &&
      this.inflight.size === 0 &&
      empty(this.held) &&
      empty(this.mine) &&
      empty(this.problems)
    );
  }

  /** Record an edit. It is sent after the debounce delay, unless it would be refused. */
  set(field: string, value: unknown) {
    const problem = this.opts.validate?.(field, value) ?? null;
    if (problem) this.problems[field] = problem;
    else delete this.problems[field];
    if (field in this.mine) {
      // In conflict: the person's text is kept (and shown), but not sent until they choose.
      this.mine[field] = value;
      this.sync();
      return;
    }
    delete this.failed[field];
    if (problem) {
      this.held[field] = value;
      delete this.pending[field];
    } else {
      delete this.held[field];
      if (same(this.basis(field), value)) delete this.pending[field];
      else this.pending[field] = value;
    }
    this.sync();
    this.restartTimer(!empty(this.pending));
  }

  /** Settle a conflict: keep what was typed here (saved over the other version), or take the other version. */
  resolve(field: string, keep: "mine" | "theirs") {
    if (!(field in this.mine)) return;
    const value = this.mine[field];
    delete this.mine[field];
    delete this.conflicts[field];
    if (keep === "mine") return this.set(field, value);
    delete this.problems[field];
    this.sync();
  }

  private restartTimer(start: boolean) {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (start)
      this.timer = this.timers.set(() => {
        this.timer = null;
        void this.drain();
      }, this.opts.delayMs ?? AUTOSAVE_DELAY_MS);
  }

  /** Failed edits go out again with the next save, so a passing network blip does not lose them. */
  private retryFailed() {
    for (const [k, v] of Object.entries(this.failed)) if (!(k in this.pending)) this.pending[k] = v;
    this.failed = {};
  }

  /**
   * Send everything waiting now and wait for it. True when everything typed is saved (nothing
   * waiting, failed, held back as invalid, or in conflict); false otherwise (the state says why).
   */
  async flush(): Promise<boolean> {
    this.restartTimer(false);
    this.retryFailed();
    await this.drain();
    return this.isClean();
  }

  /**
   * The page is going away: send everything unsaved at once, in one request that outlives the
   * page. A save already in flight is not waited for (its continuation would never run): its
   * fields go again in this request, which also accepts the value that save leaves.
   */
  leave() {
    this.restartTimer(false);
    this.retryFailed();
    this.keepalive = true;
    if (!this.running) {
      void this.drain();
      return;
    }
    const inflight = new Map<string, unknown>();
    for (const [, p] of [...this.inflight].sort(([a], [b]) => a - b))
      for (const [k, v] of Object.entries(p)) inflight.set(k, v);
    const patch: Record<string, unknown> = { ...Object.fromEntries(inflight), ...this.pending };
    for (const k of Object.keys(patch)) if (same(this.saved[k], patch[k])) delete patch[k];
    this.pending = {};
    if (empty(patch)) return;
    const baseAlt = Object.fromEntries([...inflight].filter(([k]) => k in patch));
    const sent = this.send(patch, pick(this.saved, Object.keys(patch)), baseAlt);
    const all = Promise.allSettled([this.running, sent]).then(() => undefined);
    this.track(all);
  }

  private track(run: Promise<void>) {
    this.running = run;
    void run.finally(() => {
      if (this.running !== run) return;
      this.running = null;
      this.keepalive = false;
      this.sync();
    });
  }

  /** Drop edits not yet sent (the goal is being removed). */
  discard() {
    this.restartTimer(false);
    this.pending = {};
    this.failed = {};
    this.held = {};
    this.mine = {};
    this.problems = {};
    this.conflicts = {};
    this.sync();
  }

  /**
   * The page's copy of the goal (after a reload, or an action like Discontinue): take its values
   * for fields with nothing typed here, unless it is older than what this queue already has.
   * Fields being edited keep what was typed; a field in conflict shows the newest other version.
   * Returns the fields taken, so the editor shows them.
   */
  adopt(version: string, values: Record<string, unknown>): string[] {
    if (version < this.state.version) return [];
    const taken: string[] = [];
    let conflictsChanged = false;
    for (const [k, v] of Object.entries(values)) {
      if (k in this.mine) {
        if (!same(this.conflicts[k], v)) {
          this.conflicts[k] = v;
          this.saved[k] = v;
          conflictsChanged = true;
        }
        continue;
      }
      if (this.hasLocalEdit(k)) continue;
      if (!(k in this.saved) || !same(this.saved[k], v)) {
        this.saved[k] = v;
        taken.push(k);
      }
    }
    if (version > this.state.version || conflictsChanged) this.sync({ version });
    return taken;
  }

  /** Take a newer version after an action that changed no field being edited (Discontinue, Approve). */
  adoptVersion(version: string) {
    if (version <= this.state.version) return;
    this.sync({ version });
  }

  /** What an editor should show for a field: what was typed here, else the saved value. */
  current(field: string, fallback: unknown): unknown {
    for (const m of [this.mine, this.held, this.pending, this.failed]) if (field in m) return m[field];
    const f = this.inflightValue(field);
    if (f) return f.value;
    return field in this.saved ? this.saved[field] : fallback;
  }

  /** Add stored values for fields this queue has not seen yet (a second editor opening). */
  seed(values: Record<string, unknown>) {
    for (const [k, v] of Object.entries(values)) if (!(k in this.saved)) this.saved[k] = v;
  }

  private drain(): Promise<void> {
    if (this.running) {
      // One save at a time: the edits wait for the save in flight, then go in the next one.
      const after = this.running.then(() => this.drain());
      return after;
    }
    if (empty(this.pending) && empty(this.failed)) return Promise.resolve();
    this.track(this.loop());
    return this.running!;
  }

  /** Send one save and apply its outcome. True when it was saved. */
  private async send(
    patch: Record<string, unknown>,
    base: Record<string, unknown>,
    baseAlt?: Record<string, unknown>,
  ): Promise<SaveOutcome> {
    const seq = ++this.seq;
    this.inflight.set(seq, patch);
    this.sync();
    let r: SaveOutcome;
    try {
      r = await this.opts.save({
        patch,
        base,
        ...(baseAlt && !empty(baseAlt) ? { baseAlt } : {}),
        keepalive: this.keepalive,
      });
    } catch {
      r = { ok: false, error: "Could not reach the server. Your change will be saved when you try again." };
    }
    this.inflight.delete(seq);
    this.apply(seq, patch, r);
    return r;
  }

  private apply(seq: number, patch: Record<string, unknown>, r: SaveOutcome) {
    if (r.ok) {
      for (const [k, v] of Object.entries(patch)) {
        // A later save of the field (sent when leaving the page) may have landed first.
        if ((this.appliedSeq[k] ?? 0) > seq) continue;
        this.saved[k] = v;
        this.appliedSeq[k] = seq;
        this.savedFields.add(k);
      }
      this.sync({
        version: r.updatedAt > this.state.version ? r.updatedAt : this.state.version,
        returnedToDraft: !!r.returnedToDraft,
      });
      this.opts.onSaved?.();
      return;
    }
    if (r.conflict) {
      const c = r.conflict;
      for (const k of Object.keys(patch)) {
        if (!c.fields.includes(k)) {
          // Not changed elsewhere: sent again (unless something newer was typed meanwhile).
          if (!(k in this.pending) && !(k in this.held) && !(k in this.mine)) this.pending[k] = patch[k];
          continue;
        }
        const theirs = c.current[k];
        this.saved[k] = theirs;
        this.appliedSeq[k] = seq;
        // The newest text typed here: kept, shown, and not sent until the person chooses.
        const mine =
          k in this.mine
            ? this.mine[k]
            : k in this.held
              ? this.held[k]
              : k in this.pending
                ? this.pending[k]
                : patch[k];
        delete this.held[k];
        delete this.pending[k];
        delete this.failed[k];
        if (same(mine, theirs)) {
          delete this.mine[k];
          delete this.conflicts[k];
        } else {
          this.mine[k] = mine;
          this.conflicts[k] = theirs;
        }
      }
      const version = c.updatedAt && c.updatedAt > this.state.version ? c.updatedAt : this.state.version;
      this.sync({ version });
      this.opts.onConflict?.();
      if (!empty(this.pending)) this.restartTimer(true);
      return;
    }
    for (const [k, v] of Object.entries(patch))
      if (!(k in this.pending) && !(k in this.held) && !(k in this.failed)) this.failed[k] = v;
    this.error = r.error;
    this.sync();
  }

  private async loop() {
    for (;;) {
      this.retryFailed();
      const patch = Object.fromEntries(
        Object.entries(this.pending).filter(([k, v]) => !same(this.basis(k), v)),
      );
      this.pending = {};
      if (empty(patch)) break;
      const keys = Object.keys(patch);
      const r = await this.send(patch, Object.fromEntries(keys.map((k) => [k, this.basis(k)])));
      // A failed save stops here: it is sent again with the next edit or flush.
      if (!r.ok && !r.conflict) break;
      // A conflict re-queues the other fields; the timer sends them (never in a tight loop).
      if (!r.ok) break;
    }
  }
}
