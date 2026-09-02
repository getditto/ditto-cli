import { readState, writeState } from "../config/state.js";

/**
 * Non-blocking update check against the npm registry for `@dittolive/cli`.
 * Result is cached in state.json with a 24h TTL; failures are silent.
 *
 * Opt-outs (checked by callers): CI, DITTO_NO_UPDATE_CHECK, --no-update-check,
 * non-TTY, --format json.
 */

const PKG = "@dittolive/cli";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckCache {
  checkedAt: number;
  latest: string;
}

export interface UpdateStatus {
  current: string;
  latest: string;
  updateAvailable: boolean;
  fromCache: boolean;
}

export function readCachedUpdate(now = Date.now()): UpdateCheckCache | undefined {
  const cache = readState().updateCheck as UpdateCheckCache | undefined;
  if (!cache || typeof cache.latest !== "string" || typeof cache.checkedAt !== "number")
    return undefined;
  return cache;
}

/** Bump the cache without checking freshness (callers decide). */
export function cacheUpdate(latest: string): void {
  writeState({ updateCheck: { checkedAt: Date.now(), latest } });
}

export function cacheFresh(cache: UpdateCheckCache, now = Date.now()): boolean {
  return now - cache.checkedAt < TTL_MS;
}

/** Fetch the registry's latest version (throws on any failure). */
export async function fetchLatestVersion(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(PKG)}/latest`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`);
  const body = (await res.json()) as { version?: string };
  if (!body.version) throw new Error("no version in registry response");
  return body.version;
}

/** Compare two semver-ish versions (numeric segments only; pre-release suffixes compare as older). */
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/**
 * Check for updates: fresh cache wins; otherwise fetch (callers must tolerate
 * slowness — this hits the network). Throws on fetch failure.
 */
export async function checkForUpdate(
  current: string,
  opts: { now?: number; fetchFn?: typeof fetch; force?: boolean } = {},
): Promise<UpdateStatus | undefined> {
  const now = opts.now ?? Date.now();
  const cached = readCachedUpdate(now);
  if (cached && !opts.force && cacheFresh(cached, now)) {
    return {
      current,
      latest: cached.latest,
      updateAvailable: isNewer(current, cached.latest),
      fromCache: true,
    };
  }
  const latest = await fetchLatestVersion(opts.fetchFn);
  cacheUpdate(latest);
  return { current, latest, updateAvailable: isNewer(current, latest), fromCache: false };
}

/** Whether the banner may show at all (environment-level opt-outs). */
export function updateCheckAllowed(
  opts: { ci?: boolean; quiet?: boolean; jsonOut?: boolean; isTTY?: boolean } = {},
): boolean {
  if (process.env.DITTO_NO_UPDATE_CHECK) return false;
  if (opts.ci ?? process.env.CI) return false;
  if (opts.quiet) return false;
  if (opts.jsonOut) return false;
  if (!(opts.isTTY ?? process.stderr.isTTY)) return false;
  return true;
}
