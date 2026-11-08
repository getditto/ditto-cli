import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";
import type { LessonRunner } from "../runner.js";
import type { UiSnapshot, UiStore } from "./store.js";

/**
 * Provider for the lesson screen. The LessonRunner owns the Ditto session
 * (through its QueryExecutor), so components reach the store only via the
 * runner and never see the SDK directly — tests swap in a runner over a
 * fake executor.
 */
interface TutorialContextValue {
  runner: LessonRunner;
  store: UiStore;
}

const TutorialContext = createContext<TutorialContextValue | null>(null);

export function TutorialProvider({
  runner,
  store,
  children,
}: TutorialContextValue & { children?: ReactNode }) {
  const value = useMemo(() => ({ runner, store }), [runner, store]);
  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>;
}

export function useTutorial(): TutorialContextValue {
  const ctx = useContext(TutorialContext);
  if (!ctx) throw new Error("useTutorial must be used inside <TutorialProvider>");
  return ctx;
}

/** The output log and lesson-change counter; re-renders when either changes. */
export function useTutorialSnapshot(): UiSnapshot {
  const { store } = useTutorial();
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
