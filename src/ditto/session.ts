import fs from "node:fs";
import type * as sdk from "@dittolive/ditto";
import type { Identity } from "../identity/token.js";
import { scrubEnvForSdk } from "./sanitize-env.js";

export class LockError extends Error {
  readonly exitCode = 4;
  constructor(dir: string) {
    super(
      `The data directory is in use by another ditto process: ${dir}\n` +
        `Close the other process, or pass --data-dir to use a different directory.`,
    );
    this.name = "LockError";
  }
}

/** Minimal structural interface so runners can be unit-tested without the native SDK. */
export interface QueryExecutor {
  execute(statement: string, args?: sdk.DQLQueryArguments): Promise<sdk.QueryResult>;
}

/** Data-directory creation/writability failures → exit 3 (platform bucket). */
export class DataDirError extends Error {
  readonly exitCode = 3;
  constructor(dir: string, cause: string) {
    super(`Cannot create or write the data directory: ${dir}\n${cause}`);
    this.name = "DataDirError";
  }
}

/** Token/license failures (invalid, unverifiable, or expired credentials) → exit 3. */
export class TokenError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/** The SDK can't load on this platform (unsupported OS/arch) → exit 3. */
export class PlatformError extends Error {
  readonly exitCode = 3;
  constructor(cause: string) {
    super(
      `The Ditto SDK could not load on ${process.platform}/${process.arch}: ${cause}\n` +
        `Supported: macOS arm64, Linux x64/arm64, Windows x64 (Node 22+).`,
    );
    this.name = "PlatformError";
  }
}

/** SDK errors that indicate a credential problem rather than a query problem. */
export function isLicenseError(err: unknown): boolean {
  const e = err as { message?: string; code?: string };
  const text = `${e.code ?? ""} ${e.message ?? ""}`;
  return (
    /license|token|verification|unauthorized|authenticat/i.test(text) && !/query|dql/i.test(text)
  );
}

// The SDK is loaded lazily: its native tracing layer panics (abort/exit 134)
// when NO_COLOR is set, so we scrub the env BEFORE first evaluation.
type DittoSdk = typeof import("@dittolive/ditto");
let sdkModule: DittoSdk | undefined;
let initialized = false;

async function loadSdk(): Promise<DittoSdk> {
  if (!sdkModule) {
    scrubEnvForSdk();
    try {
      sdkModule = await import("@dittolive/ditto");
    } catch (err) {
      // Native module missing for this OS/arch (darwin-x64, win32-arm64, …)
      throw new PlatformError((err as Error).message);
    }
  }
  return sdkModule;
}

export class DittoSession {
  private constructor(private readonly ditto: sdk.Ditto) {}

  /**
   * Open an offline-only session. Sync is never started.
   */
  static async open(identity: Identity, dataDir: string): Promise<DittoSession> {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      throw new DataDirError(dataDir, (err as NodeJS.ErrnoException).message);
    }

    const sdk = await loadSdk();
    if (!initialized) {
      // Keep SDK logs off stdout/stderr so results stay pipeable.
      // Known cosmetic issue: the native tracing bootstrap still writes 7
      // WARN/INFO lines to stderr at init (fd-level writes, not suppressible
      // from JS). stdout stays clean; piping is unaffected.
      sdk.Logger.enabled = false;
      await sdk.init();
      initialized = true;
    }

    const config = new sdk.DittoConfig(identity.appId, { mode: "smallPeersOnly" }, dataDir);
    let ditto: sdk.Ditto;
    try {
      ditto = await sdk.Ditto.open(config);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      const message = (err as Error).message ?? "";
      if (
        code.includes("persistence-directory-locked") ||
        message.includes("File already locked")
      ) {
        throw new LockError(dataDir);
      }
      // Dir exists but is unwritable — the SDK reports the raw OS error.
      if (/permission denied|EACCES|os error 13/i.test(message)) {
        throw new DataDirError(
          dataDir,
          `Permission denied — check the directory's permissions (chmod/chown).`,
        );
      }
      if (isLicenseError(err)) {
        throw new TokenError(`License rejected: ${message}`);
      }
      throw err;
    }
    try {
      await ditto.setOfflineOnlyLicenseToken(identity.token);
    } catch (err) {
      // Don't leak the opened (lock-holding) Ditto on license failure.
      await ditto.close().catch(() => {});
      if (isLicenseError(err)) {
        throw new TokenError(`License rejected: ${(err as Error).message}`);
      }
      throw err;
    }
    // NOTE: startSync() is intentionally never called (offline-only, shared app id).
    return new DittoSession(ditto);
  }

  /** Execute one DQL statement (the SDK accepts exactly one per call, no trailing ";"). */
  async execute(statement: string, args?: sdk.DQLQueryArguments): Promise<sdk.QueryResult> {
    return this.ditto.store.execute(statement, args);
  }

  async close(): Promise<void> {
    await this.ditto.close();
  }
}
