import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config/paths.js";

/** The most recent failed command, saved so `doctor --report` can include it. */
export interface LastError {
  time: string;
  version: string;
  /** Arguments after `dittosh`, redacted. */
  command: string[];
  exitCode: number;
  /** The last lines the command wrote to stderr (colors stripped, redacted). */
  stderr: string[];
  /** Stack trace of an unexpected error, when there was one. */
  stack?: string;
}

export const LAST_ERROR_FILE = "last-error.json";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface StderrTail {
  lines(): string[];
  stop(): void;
}

/**
 * Keep the last `max` lines written to stderr, passing every write through
 * unchanged. Lets a failure be saved with the message the user saw.
 */
export function startStderrTail(stream: NodeJS.WriteStream = process.stderr, max = 60): StderrTail {
  const kept: string[] = [];
  let partial = "";
  const original = stream.write;
  const push = (chunk: unknown) => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
    const parts = (partial + text.replace(ANSI, "")).split(/\r?\n/);
    partial = parts.pop() ?? "";
    for (const line of parts) {
      kept.push(line);
      if (kept.length > max) kept.shift();
    }
  };
  stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
    try {
      push(chunk);
    } catch {
      // never let capture break output
    }
    return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof stream.write;
  return {
    lines: () => {
      const all = partial ? [...kept, partial] : [...kept];
      return all.slice(-max);
    },
    stop: () => {
      stream.write = original;
    },
  };
}

/** Best-effort: a read-only config dir must never turn into a second failure. */
export function recordLastError(entry: LastError, dir: string = configDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LAST_ERROR_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // ignore
  }
}

export function readLastError(dir: string = configDir()): LastError | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, LAST_ERROR_FILE), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const e = parsed as Partial<LastError>;
    if (typeof e.time !== "string" || !Array.isArray(e.command)) return null;
    return {
      time: e.time,
      version: String(e.version ?? "unknown"),
      command: e.command.map(String),
      exitCode: Number(e.exitCode ?? 1),
      stderr: Array.isArray(e.stderr) ? e.stderr.map(String) : [],
      ...(typeof e.stack === "string" ? { stack: e.stack } : {}),
    };
  } catch {
    return null;
  }
}

/** Commands whose own failures shouldn't replace the error being diagnosed. */
export function isDiagnosticCommand(argv: string[]): boolean {
  return argv.some((a) => a === "doctor" || a === "support-bundle");
}
