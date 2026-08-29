import type { DQLQueryArguments } from "@dittolive/ditto";

export class ParamError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "ParamError";
  }
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
    if (eq === -1 || eq === 0) {
      throw new ParamError(`--param must be name=value, got: "${pair}"`);
    }
    const name = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw; // bare string fallback
    }
    out = out ?? {};
    out[name] = value;
  }

  return out as DQLQueryArguments | undefined;
}
