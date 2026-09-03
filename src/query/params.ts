import fs from "node:fs";
import type { DQLQueryArguments } from "@dittolive/ditto";
import { expandTilde } from "../config/paths.js";

export class ParamError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
}

/**
 * Resolve the --args value to a JSON string:
 *  - `--args '{"id":1}'`  inline (returned as-is)
 *  - `--args -`           read from stdin (the jq pipeline form)
 *  - `--args @file.json`  read from a file (curl-style)
 * The result is validated by parseParams (must be a JSON object).
 */
export async function resolveArgsSource(
  value: string | undefined,
  readStdin: () => Promise<string>,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value === "-") return readStdin();
  if (value.startsWith("@")) {
    const file = value.slice(1).trim();
    if (!file) {
      throw new ParamError("--args @ requires a file path (e.g. --args @params.json)");
    }
    try {
      return fs.readFileSync(expandTilde(file), "utf8");
    } catch (err) {
      throw new ParamError(`--args: cannot read ${file}: ${(err as Error).message}`);
    }
  }
  return value;
}

/** Parse a CLI integer flag; usage error (exit 2) on garbage or out-of-range. */
export function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  if (raw === undefined) return fallback;
  const min = opts?.min ?? 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || String(n) !== raw.trim()) {
    throw new ParamError(`${flag} must be an integer ≥ ${min}, got "${raw}"`);
  }
  if (opts?.max !== undefined && n > opts.max) {
    throw new ParamError(
      `${flag} must be at most ${opts.max.toLocaleString()}, got ${n.toLocaleString()}`,
    );
  }
  return n;
}

/**
 * Build SDK query arguments from CLI input:
 *  - `--args '<json-object>'` (base set)
 *  - `-p/--param name=value` (repeatable; value JSON-parsed with string fallback)
 *
 * `-p` values override `--args` keys on conflict.
 */
export function parseParams(
  pairs: string[] | undefined,
  argsJson: string | undefined,
): DQLQueryArguments | undefined {
  let out: Record<string, unknown> | undefined;

  if (argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      throw new ParamError(`--args must be a JSON object, got: ${argsJson}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ParamError(`--args must be a JSON object, got: ${argsJson}`);
    }
    out = parsed as Record<string, unknown>;
  }

  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      throw new ParamError(`--param must be name=value, got: "${pair}"`);
    }
    const name = pair.slice(0, eq).trim();
    if (name === "") {
      throw new ParamError(`--param must be name=value, got: "${pair}" (empty name)`);
    }
    if (name === "__proto__" || name === "constructor" || name === "prototype") {
      throw new ParamError(`--param name "${name}" is not allowed (prototype pollution guard)`);
    }
    const raw = pair.slice(eq + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw; // bare string fallback
    }
    out = out ?? {};
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return out as DQLQueryArguments | undefined;
}
