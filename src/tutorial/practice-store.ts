import fs from "node:fs";
import path from "node:path";
import { expandTilde } from "../config/paths.js";

/**
 * The lessons reset their store on every lesson change (EVICT FROM products,
 * suppliers, orders). A marker file records that a directory is a practice
 * store, so `-d` can never point that reset at real data.
 */
export const PRACTICE_MARKER = ".dittosh-tutorial-store";

/**
 * The store directory for `tutorial -i`: the `-d` value when it's non-blank
 * (commander keeps `=` from `-d=x`), otherwise the tutorial's own store.
 * Never falls back to DITTOSH_DATA_DIR or the default dql store.
 */
export function practiceStoreDir(flag: string | undefined, tutorialDir: string): string {
  const cleaned = flag?.replace(/^=/, "").trim();
  return cleaned ? path.resolve(expandTilde(cleaned)) : tutorialDir;
}

export type PracticeStoreCheck = { ok: true } | { ok: false; reason: string };

/**
 * Safe to use as a practice store: the tutorial's own directory, a directory
 * that doesn't exist or is empty, or one already marked as a practice store.
 */
export function checkPracticeStore(dir: string, tutorialDir: string): PracticeStoreCheck {
  if (path.resolve(dir) === path.resolve(tutorialDir)) return { ok: true };
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return { ok: false, reason: `can't read ${dir}: ${(err as Error).message}` };
  }
  if (entries.length === 0 || entries.includes(PRACTICE_MARKER)) return { ok: true };
  return {
    ok: false,
    reason: `${dir} isn't a lesson practice store. The lessons replace the products, suppliers, and orders collections in their store, so they only use an empty directory or one they created. Leave out --data-dir to use the lessons' own store.`,
  };
}

/** Record that `dir` is a practice store (after the store has been opened). */
export function markPracticeStore(dir: string): void {
  try {
    fs.writeFileSync(
      path.join(dir, PRACTICE_MARKER),
      "Created by `dittosh tutorial --interactive`. The lessons reset this store's data.\n",
    );
  } catch {
    // Best effort: without the marker a later -d run refuses, which is safe.
  }
}
