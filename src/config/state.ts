import fs from "node:fs";
import path from "node:path";
import { configDir } from "./paths.js";

/**
 * Tiny persisted state store (<config dir>/state.json). Holds one-time warning
 * flags (e.g. the no-LIMIT warning) and later the update-check cache.
 */
export interface CliState {
  noLimitWarned?: boolean;
  [key: string]: unknown;
}

function stateFile(): string {
  return path.join(configDir(), "state.json");
}

export function readState(): CliState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    // Corrupt or non-object content (including "null") is not state.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as CliState;
  } catch {
    return {};
  }
}

/** Best-effort: state is a one-time-warning nicety and must never fail a query. */
export function writeState(patch: CliState): CliState {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    // tmp + rename: concurrent writers must not corrupt or partially write it
    // (this file will also hold the update-check cache, which is NOT loss-tolerant).
    const tmp = `${stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, stateFile());
    // Sweep orphaned tmp files from crashed writers — but only ones older
    // than a minute (a live process's in-flight tmp must not be deleted).
    try {
      const base = path.basename(stateFile());
      const cutoff = Date.now() - 60_000;
      for (const f of fs.readdirSync(configDir())) {
        if (f.startsWith(`${base}.`) && f.endsWith(".tmp")) {
          try {
            if (fs.statSync(path.join(configDir(), f)).mtimeMs < cutoff) {
              fs.rmSync(path.join(configDir(), f), { force: true });
            }
          } catch {
            // gone already — fine
          }
        }
      }
    } catch {
      // best-effort sweep
    }
  } catch {
    // read-only config dir (sandboxed CI etc.) — fine, warn again next time
  }
  return next;
}
