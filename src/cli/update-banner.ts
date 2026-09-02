import chalk from "chalk";
import { checkForUpdate, isNewer, readCachedUpdate, updateCheckAllowed } from "../update/check.js";

/**
 * The update banner: one line on stderr after a successful command, only when
 * the cache already knows a newer version exists (instant — never blocks).
 * A stale cache refreshes in the background for next time (≤1s cap).
 */
export async function maybeShowUpdateBanner(
  current: string,
  opts: { noCheckFlag?: boolean; quiet?: boolean; isTTY?: boolean } = {},
): Promise<void> {
  if (opts.noCheckFlag) return;
  if (!updateCheckAllowed({ quiet: opts.quiet, isTTY: opts.isTTY })) return;

  // Instant: read the cache; show when newer.
  const cached = readCachedUpdate();
  if (cached && isNewer(current, cached.latest)) {
    console.error(
      chalk.yellow(`update available: ${current} → ${cached.latest}`) +
        chalk.dim("  (ditto update)"),
    );
  }

  // Background refresh when stale (never blocks output; capped at 1s).
  if (!cached || !checkFreshEnough(cached)) {
    void checkForUpdate(current, { force: true, fetchFn: fetchWithTimeout }).catch(() => {});
  }
}

function checkFreshEnough(cache: { checkedAt: number }): boolean {
  return Date.now() - cache.checkedAt < 24 * 60 * 60 * 1000;
}

const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(1000) });
