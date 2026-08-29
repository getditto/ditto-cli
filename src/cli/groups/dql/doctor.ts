import fs from "node:fs";
import { resolveDataDir } from "../../../config/paths.js";
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

export interface DoctorOptions {
  dataDir?: string;
  /** Injectable for tests. */
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
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
  let writable = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    writable = true;
  } catch {
    /* reported below */
  }
  checks.push({
    ok: writable,
    label: "data directory",
    detail: writable ? dataDir : `not writable: ${dataDir}`,
  });

  try {
    const identity = loadIdentity(env);
    const days = daysUntilExpiry(identity.expiresOn);
    checks.push({
      ok: true,
      label: "token",
      detail: days === null ? "loaded" : `loaded, expires ${identity.expiresOn} (${days}d)`,
    });
  } catch (err) {
    checks.push({
      ok: false,
      label: "token",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return checks;
}
