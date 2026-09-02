import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";

// Resolved lazily (not at module load) so tests can redirect via env vars.
// NOTE: env-paths captures os.homedir() at module load — never cache its result
// at module scope if you want env overrides to work, and prefer the explicit
// DITTOSH_*_DIR overrides in tests.
const paths = () => envPaths("dittosh", { suffix: "" });

/** OS-default data directory (macOS ~/Library/Application Support/dittosh, Linux ~/.local/share/dittosh, Windows %LOCALAPPDATA%\dittosh). */
export function defaultDataDir(): string {
  return paths().data;
}

/** Config directory (update-check cache, one-time-warning flags). `DITTOSH_CONFIG_DIR` overrides — used by tests, handy for portable setups. */
export function configDir(): string {
  const override = process.env.DITTOSH_CONFIG_DIR;
  return override?.trim() ? override : paths().config;
}

/** Expand a leading `~` to the home directory. */
export function expandTilde(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Values that are never a real data dir (commander artifacts / typo guards): `-d --`, `-d -`, `-d=--`. */
export function isBogusDataDir(v?: string): boolean {
  if (v === undefined) return false;
  const cleaned = v.replace(/^=/, "").trim();
  return cleaned === "--" || cleaned === "-";
}

/**
 * Data directory resolution precedence:
 *   --data-dir flag > DITTOSH_DATA_DIR env var > OS default
 * Empty strings fall through (commander accepts `-d ""`; cwd is never intended).
 */
export function resolveDataDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  // Commander's short-option `=` form keeps the "=" (e.g. `-d=/tmp/x` → "=/tmp/x") — strip it.
  const clean = (v?: string) => v?.replace(/^=/, "").trim();
  const chosen = clean(flag)
    ? clean(flag)
    : clean(env.DITTOSH_DATA_DIR)
      ? clean(env.DITTOSH_DATA_DIR)
      : undefined;
  const dir = chosen ?? defaultDataDir();
  return path.resolve(expandTilde(dir));
}
