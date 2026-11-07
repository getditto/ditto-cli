/**
 * The bridge between LessonRunner (plain TypeScript) and the React screen.
 * The runner prints into the log and signals lesson changes; components
 * subscribe through useSyncExternalStore. No React here, so the runner
 * never depends on the UI.
 */
export interface UiSnapshot {
  log: readonly string[];
  /** Bumped whenever the current lesson changes. */
  lessonVersion: number;
  /** Total entries ever printed (the log itself is capped). */
  printed: number;
  /** The latest verdict (✓ / ✗ / query error), shown above the prompt. */
  status: string | null;
}

export interface UiStore {
  print: (text: string) => void;
  lessonChanged: () => void;
  /** Empty the log (each action starts with a clean results panel). */
  clear: () => void;
  setStatus: (text: string | null) => void;
  subscribe: (cb: () => void) => () => void;
  snapshot: () => UiSnapshot;
  /** Output panel width, so the runner fits result tables to it. */
  width: () => number;
  setWidth: (width: number) => void;
}

export function createUiStore(opts: { width?: number; maxEntries?: number } = {}): UiStore {
  const maxEntries = opts.maxEntries ?? 300;
  let width = opts.width ?? 76;
  let snap: UiSnapshot = { log: [], lessonVersion: 0, printed: 0, status: null };
  const subs = new Set<() => void>();
  const emit = () => {
    for (const cb of subs) cb();
  };
  return {
    print(text) {
      snap = { ...snap, log: [...snap.log, text].slice(-maxEntries), printed: snap.printed + 1 };
      emit();
    },
    clear() {
      if (snap.log.length === 0) return;
      snap = { ...snap, log: [] };
      emit();
    },
    lessonChanged() {
      snap = { ...snap, lessonVersion: snap.lessonVersion + 1 };
      emit();
    },
    setStatus(status) {
      if (status === snap.status) return;
      snap = { ...snap, status };
      emit();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    snapshot: () => snap,
    width: () => width,
    setWidth(w) {
      width = w;
    },
  };
}
