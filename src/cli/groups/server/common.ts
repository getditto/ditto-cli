import chalk from "chalk";
import type { Command } from "commander";
import { ParamError } from "../../../query/params.js";
import {
  type FetchLike,
  PortalApiError,
  PortalClient,
  PortalConnectionError,
  PortalTimeoutError,
} from "../../../server/client.js";
import {
  ApiVersionError,
  resolveServerConfig,
  type ServerConfig,
  ServerConfigError,
} from "../../../server/config.js";

/**
 * Shared wiring for every `dittosh server` subcommand: connection flags,
 * config resolution (flags > shell env > cwd .env), and error→exit-code mapping.
 */

export interface ServerOpts {
  url?: string;
  apiKey?: string;
}

/**
 * Commander 14 keeps a leading "=" for dual short/long options in several
 * forms (`-e=x`, `--execute==x`, even `--execute =x`) — strip exactly one.
 * Only apply to dual short/long options (-e/-f/-o/-p). Trade-off: a value
 * that legitimately starts with "=" loses it there (never a valid DQL
 * statement; pathological for file paths). Long-only options must NOT be
 * stripped.
 */
export const stripEq = (v?: string) => v?.replace(/^=/, "");

/** Connection flags present on every server subcommand (env vars documented in each --help). */
export function addServerOpts<T extends Command>(cmd: T): T {
  return cmd
    .option("--url <url>", "Ditto Server URL (env: DITTOSH_SERVER_URL, or .env)")
    .option("--api-key <key>", "HTTP API key (env: DITTOSH_SERVER_API_KEY, or .env)");
}

export interface ServerConnection {
  client: PortalClient;
  config: ServerConfig;
}

/** Injectable plumbing for tests (unit tests wire a mock fetch — no network). */
export interface ServerDeps {
  fetchImpl?: FetchLike;
}

/** Resolve config and build a client; on failure print + set the exit code and return null. */
export function connect(
  opts: ServerOpts & { apiVersion?: string },
  deps: ServerDeps = {},
): ServerConnection | null {
  try {
    // No stripEq here: --url/--api-key/--api-version are long-only options.
    const config = resolveServerConfig({
      url: opts.url,
      apiKey: opts.apiKey,
      apiVersion: opts.apiVersion,
    });
    return {
      client: new PortalClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        fetchImpl: deps.fetchImpl,
      }),
      config,
    };
  } catch (err) {
    if (err instanceof ServerConfigError || err instanceof ApiVersionError) {
      console.error(chalk.red(err.message));
      process.exitCode = err.exitCode;
      return null;
    }
    throw err;
  }
}

/** Map a client failure to stderr + exit code. Returns true when the error was handled. */
export function reportServerError(err: unknown): boolean {
  if (
    err instanceof PortalApiError ||
    err instanceof PortalConnectionError ||
    err instanceof PortalTimeoutError
  ) {
    console.error(chalk.red(err.message));
    process.exitCode = err.exitCode;
    return true;
  }
  return false;
}

/** Wrap a subcommand action with the standard server error mapping. */
export function withServerErrors<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (!reportServerError(err)) throw err;
    }
  };
}

/** Parse a JSON flag value (inline, @file, or "-" handled upstream); usage error on garbage. */
export function parseJsonFlag(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ParamError(`${flag} must be valid JSON, got: ${raw.slice(0, 80)}`);
  }
}

/** Destructive server writes: -y skips; a TTY prompts; piped without -y is a usage error. */
export async function confirmDestructive(message: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!(process.stdin.isTTY && process.stderr.isTTY)) {
    console.error(chalk.red(`${message} — pass -y/--yes to confirm (non-interactive)`));
    process.exitCode = 2;
    return false;
  }
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: false }, { input: process.stdin, output: process.stderr });
}
