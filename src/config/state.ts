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
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as CliState;
  } catch {
    return {};
  }
}

export function writeState(patch: CliState): CliState {
  const next = { ...readState(), ...patch };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
