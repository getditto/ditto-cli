import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBogusDataDir, resolveDataDir } from "../../../config/paths.js";
import type { Identity } from "../../../identity/token.js";
import { daysUntilExpiry, loadIdentity } from "../../../identity/token.js";

export interface DoctorCheck {
  ok: boolean;
  label: string;
  detail: string;
}

/** Native matrix of @dittolive/ditto@5.1.0 (verified from the npm tarball). */
const SUPPORTED: Record<string, string[]> = {
  darwin: ["arm64"],
  linux: ["x64", "arm64"],
  win32: ["x64"],
};

/** lstat detects dangling symlinks (existsSync follows links and reports them missing). */
function existsAsDanglingLink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true; // lstat works but existsSync failed → dangling link
  } catch {
    return false;
  }
}

export interface DoctorOptions {
  dataDir?: string;
  /** Injectable for tests. */
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: open+close a throwaway store. Default opens a real one. */
  openStore?: (identity: Identity, dir: string) => Promise<void>;
}

/** Collect doctor checks without printing anything (rendering lives in the command). */
export async function collectDoctorChecks(opts: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const env = opts.env ?? process.env;

  const checks: DoctorCheck[] = [];

  const arches = SUPPORTED[platform];
  const platformOk = arches?.includes(arch) ?? false;
  checks.push({
    ok: platformOk,
    label: "platform",
    detail: platformOk
      ? `${platform}/${arch} supported`
      : `${platform}/${arch} is not supported by the Ditto Node SDK 5.1.0 (supported: macOS arm64, Linux x64/arm64, Windows x64)`,
  });

  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push({
    ok: nodeMajor >= 20,
    label: "node",
    detail: `v${nodeVersion}${nodeMajor >= 20 ? "" : " — Node 20+ required"}`,
  });

  const dataDir = resolveDataDir(opts.dataDir, env);
  let dirDetail: string;
  let dirOk: boolean;
  // Respect precedence: the flag wins when present (whitespace-only falls through); only flag-absent env is checked.
  if (isBogusDataDir(opts.dataDir)) {
    dirOk = false;
    dirDetail = "bogus --data-dir value: expected a directory path";
  } else if (!opts.dataDir?.trim() && isBogusDataDir(env.DITTO_DATA_DIR)) {
    dirOk = false;
    dirDetail = "bogus DITTO_DATA_DIR value: expected a directory path";
  } else if (fs.existsSync(dataDir)) {
    if (!fs.statSync(dataDir).isDirectory()) {
      dirOk = false;
      dirDetail = `not a directory: ${dataDir}`;
    } else {
      try {
        fs.accessSync(dataDir, fs.constants.W_OK);
        dirOk = true;
        dirDetail = dataDir;
      } catch {
        dirOk = false;
        dirDetail = `not writable: ${dataDir}`;
      }
    }
  } else if (fs.existsSync(dataDir) === false && existsAsDanglingLink(dataDir)) {
    dirOk = false;
    dirDetail = `dangling symlink: ${dataDir}`;
  } else {
    // Don't create the dir for a read-only health check — probe the nearest
    // existing ancestor instead.
    let probe = dataDir;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    // A file where the dir (or an ancestor of it) should be is a failure.
    try {
      if (!fs.statSync(probe).isDirectory()) throw new Error("not a directory");
      fs.accessSync(probe, fs.constants.W_OK);
      dirOk = true;
      dirDetail = `${dataDir} (will be created)`;
    } catch {
      dirOk = false;
      dirDetail = `not creatable: ${dataDir} (check ${probe})`;
    }
  }
  checks.push({ ok: dirOk, label: "data directory", detail: dirDetail });

  try {
    const identity = loadIdentity(env);
    const days = daysUntilExpiry(identity.expiresOn);
    // Dev tokens with stale EXPIRE_ON are accepted by the SDK — show "expired", not negative days.
    const detail =
      days === null
        ? "loaded"
        : days < 0
          ? `loaded, expired ${identity.expiresOn}`
          : `loaded, expires ${identity.expiresOn} (${days}d)`;
    checks.push({
      ok: true,
      label: "token",
      detail,
    });
    // Strongest check: actually open a store with the token (validates SDK
    // native load + license acceptance) in a throwaway dir.
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-doctor-"));
      try {
        const openStore =
          opts.openStore ??
          (async (id: Identity, dir: string) => {
            const { DittoSession } = await import("../../../ditto/session.js");
            const session = await DittoSession.open(id, dir);
            await session.close();
          });
        await openStore(identity, tmp);
        checks.push({
          ok: true,
          label: "sdk",
          detail: "native SDK loaded; store opened and closed",
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } catch (err) {
      checks.push({
        ok: false,
        label: "sdk",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Lock probe: if the resolved data dir already holds a store, try opening
    // it — a held lock is the top "why is my CLI broken" cause.
    if (fs.existsSync(path.join(dataDir, "__ditto_lock_file"))) {
      try {
        const { DittoSession } = await import("../../../ditto/session.js");
        const probe = await DittoSession.open(identity, dataDir);
        await probe.close();
        checks.push({ ok: true, label: "lock", detail: "data directory is free" });
      } catch (err) {
        // Only an actual lock is "locked" — other failures are store-open problems.
        const isLock = err instanceof Error && err.name === "LockError";
        checks.push({
          ok: false,
          label: "lock",
          detail: isLock
            ? `data directory is locked by another process — close it, or use -d to point elsewhere (${(err as Error).message.split("\n")[0]})`
            : `store failed to open: ${(err as Error).message}`,
        });
      }
    }
  } catch (err) {
    checks.push({
      ok: false,
      label: "token",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return checks;
}
