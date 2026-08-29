/**
 * Identity / token loading.
 *
 * Release builds embed a Ditto-issued offline license token (obfuscated — see
 * plans/SDKS-4855-dql-cli-tool.md §Token obfuscation) and ignore all
 * environment credentials. Dev/unbundled builds read a developer token from
 * the repo-root `.env` (loaded via `node --env-file` / tsx `--env-file`):
 *
 *   DATABASE_ID    — app/database id
 *   OFFLINE_TOKEN  — offline license / playground token
 *   EXPIRE_ON      — ISO date the token expires (informational)
 *
 * `DQL_OFFLINE_LICENSE` / `DITTO_APP_ID` are accepted as fallback aliases for
 * CI parity with the agent-skills repo.
 */

// Overridden to `true` by the release build (tsup define). Do not reference
// import.meta.env or process.env trickery here — this constant is the guard.
declare const RELEASE: string | undefined;
const isRelease =
  typeof RELEASE !== "undefined" ? RELEASE === "true" : false;

export interface Identity {
  appId: string;
  token: string;
  /** ISO date string when the token expires, if known. */
  expiresOn?: string;
}

export class IdentityError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export function loadIdentity(env: NodeJS.ProcessEnv = process.env): Identity {
  if (isRelease) {
    // TODO(M8): reassemble embedded token from build/token-chunks.ts.
    throw new IdentityError(
      "This build has no embedded license token. Release builds are stamped at publish time.",
    );
  }
  const appId = env.DATABASE_ID ?? env.DITTO_APP_ID;
  const token = env.OFFLINE_TOKEN ?? env.DQL_OFFLINE_LICENSE;
  const expiresOn = env.EXPIRE_ON;
  if (!appId || !token) {
    throw new IdentityError(
      "Dev build: set DATABASE_ID and OFFLINE_TOKEN in a repo-root .env (see .env.sample).",
    );
  }
  return { appId, token, expiresOn };
}

/** Days until the token expires, or null if unknown/unparseable. */
export function daysUntilExpiry(expiresOn?: string, now: Date = new Date()): number | null {
  if (!expiresOn) return null;
  const at = new Date(expiresOn);
  if (Number.isNaN(at.getTime())) return null;
  return Math.floor((at.getTime() - now.getTime()) / 86_400_000);
}
