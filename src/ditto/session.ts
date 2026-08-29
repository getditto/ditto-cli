import fs from "node:fs";
import * as sdk from "@dittolive/ditto";
import type { Identity } from "../identity/token.js";

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

let initialized = false;

export class DittoSession {
  private constructor(private readonly ditto: sdk.Ditto) {}

  /**
   * Open an offline-only session. Sync is never started.
   */
  static async open(identity: Identity, dataDir: string): Promise<DittoSession> {
    fs.mkdirSync(dataDir, { recursive: true });

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
      if (code.includes("persistence-directory-locked") || message.includes("File already locked")) {
        throw new LockError(dataDir);
      }
      throw err;
    }
    await ditto.setOfflineOnlyLicenseToken(identity.token);
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
