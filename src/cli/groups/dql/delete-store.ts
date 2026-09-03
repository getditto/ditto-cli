import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBogusDataDir, resolveDataDir } from "../../../config/paths.js";
import { loadIdentity } from "../../../identity/token.js";

export interface DeleteStoreResult {
  /** 0 deleted/nothing to delete · 2 usage · 3 delete failed · 4 store locked. */
  code: 0 | 2 | 3 | 4;
  message: string;
}

export interface DeleteStoreOptions {
  dataDir?: string;
  yes?: boolean;
  /** Injectable for tests (DITTOSH_DATA_DIR). */
  env?: NodeJS.ProcessEnv;
  /**
   * Injectable for tests: open+close the store to prove it's not locked.
   * Default opens a real session. Only runs when a `__ditto_lock_file`
   * exists (a dir without one was never opened by Ditto).
   */
  probeLock?: (dir: string) => Promise<void>;
  /** Injectable for tests. Default fs.rmSync(recursive, force). */
  rm?: (dir: string) => void;
}

/**
 * Permanently delete the local store — the whole data directory, indexes and
 * lock files included (unlike `dataset reset`, which only EVICTs documents).
 * Never gated on token validity: deleting files must always be possible.
 */
export async function deleteStore(opts: DeleteStoreOptions = {}): Promise<DeleteStoreResult> {
  const env = opts.env ?? process.env;

  // Mirror doctor/openSession: the flag wins when present; only flag-absent
  // env is bogus-checked.
  if (isBogusDataDir(opts.dataDir)) {
    return { code: 2, message: "-d/--data-dir requires a directory path" };
  }
  if (!opts.dataDir?.trim() && isBogusDataDir(env.DITTOSH_DATA_DIR)) {
    return { code: 2, message: "DITTOSH_DATA_DIR requires a directory path" };
  }
  const dir = resolveDataDir(opts.dataDir, env);

  // Deleting recursively is irreversible — refuse targets that are clearly
  // not a store, no matter how they were passed.
  if (dir === path.parse(dir).root || dir === os.homedir() || dir === process.cwd()) {
    return {
      code: 2,
      message: `Refusing to delete ${dir} — that's not a dittosh data directory.`,
    };
  }

  if (!fs.existsSync(dir)) {
    return { code: 0, message: `No store at ${dir} — nothing to delete.` };
  }

  if (!opts.yes) {
    return {
      code: 2,
      message: `This permanently deletes the store at ${dir} — all collections, indexes, and files. Re-run with --yes to confirm.`,
    };
  }

  // Lock probe: never delete a store another process has open. Probe failures
  // that aren't locks (expired token, SDK unavailable) don't block deletion.
  if (fs.existsSync(path.join(dir, "__ditto_lock_file"))) {
    const probe =
      opts.probeLock ??
      (async (d: string) => {
        const { DittoSession } = await import("../../../ditto/session.js");
        const session = await DittoSession.open(loadIdentity(env), d);
        await session.close();
      });
    try {
      await probe(dir);
    } catch (err) {
      if (err instanceof Error && err.name === "LockError") {
        return { code: 4, message: err.message };
      }
    }
  }

  const rm = opts.rm ?? ((d: string) => fs.rmSync(d, { recursive: true, force: true }));
  try {
    rm(dir);
  } catch (err) {
    return {
      code: 3,
      message: `Cannot delete ${dir}: ${(err as NodeJS.ErrnoException).message}`,
    };
  }
  return { code: 0, message: `Deleted the store at ${dir}.` };
}
