import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const hasDevCredentials = Boolean(
  (process.env.DATABASE_ID ?? process.env.DITTO_APP_ID) &&
    (process.env.OFFLINE_TOKEN ?? process.env.DQL_OFFLINE_LICENSE),
);

/** Reason string for describe.skipIf / it.skipIf. */
export const NO_CREDENTIALS =
  "requires dev credentials (DATABASE_ID + OFFLINE_TOKEN in repo-root .env)";

/** Create a unique temp data directory; caller cleans up (or relies on OS tmp reaping). */
export function tmpDataDir(prefix = "ditto-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
