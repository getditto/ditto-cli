import path from "node:path";
import os from "node:os";
import envPaths from "env-paths";

const paths = envPaths("ditto", { suffix: "" });

/** OS-default data directory (macOS ~/Library/Application Support/ditto, Linux ~/.local/share/ditto, Windows %LOCALAPPDATA%\ditto). */
export function defaultDataDir(): string {
  return paths.data;
}

/** OS-default config directory (update-check cache, one-time-warning flags). */
export function configDir(): string {
  return paths.config;
}

/**
 * Data directory resolution precedence:
 *   --data-dir flag > DITTO_DATA_DIR env var > OS default
 */
export function resolveDataDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = flag ?? env.DITTO_DATA_DIR ?? defaultDataDir();
  return path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
}
