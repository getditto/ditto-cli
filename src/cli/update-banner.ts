import chalk from "chalk";
import {
  cacheFresh,
  checkForUpdate,
  isNewer,
  readCachedUpdate,
  updateCheckAllowed,
  writeFailureCache,
} from "../update/check.js";

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
        chalk.dim("  (dittosh update)"),
    );
  }

  // Background refresh when stale (never blocks output; ≤1s cap). Failures
  // back off too (a failure-stamped cache suppresses re-fetching for the TTL).
  if (!cached || !cacheFresh(cached)) {
    void checkForUpdate(current, { force: true, fetchFn: fetchWithTimeout }).catch(() => {
      writeFailureCache(current);
    });
  }
}

const fetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(1000) });
