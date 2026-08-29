import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";

// Resolved lazily (not at module load) so tests can redirect via env vars.
// NOTE: env-paths captures os.homedir() at module load — never cache its result
// at module scope if you want env overrides to work, and prefer the explicit
// DITTO_*_DIR overrides in tests.
const paths = () => envPaths("ditto", { suffix: "" });

/** OS-default data directory (macOS ~/Library/Application Support/ditto, Linux ~/.local/share/ditto, Windows %LOCALAPPDATA%\ditto). */
export function defaultDataDir(): string {
  return paths().data;
}

/** Config directory (update-check cache, one-time-warning flags). `DITTO_CONFIG_DIR` overrides — used by tests, handy for portable setups. */
export function configDir(): string {
  return process.env.DITTO_CONFIG_DIR ?? paths().config;
}

/**
 * Data directory resolution precedence:
 *   --data-dir flag > DITTO_DATA_DIR env var > OS default
 */
export function resolveDataDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = flag ?? env.DITTO_DATA_DIR ?? defaultDataDir();
  return path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
}
