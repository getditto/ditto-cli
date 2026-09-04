import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Configuration for `dittosh server` (Ditto Server / portal HTTP API).
 *
 * Precedence (highest wins):
 *   1. CLI flags (--url / --api-key)
 *   2. Shell environment (DITTOSH_SERVER_URL / DITTOSH_SERVER_API_KEY)
 *   3. `.env` in the current working directory (never overrides real env)
 *
 * Aliases (for users coming from the Ditto docs): DITTO_CLOUD_URL, DITTO_API_KEY.
 */

export class ServerConfigError extends Error {
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

/** A bad flag VALUE (e.g. --api-version v9) — usage error, not a config absence. */
export class ApiVersionError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "ApiVersionError";
  }
}

export type ApiVersion = "v4" | "v5";

export type ConfigSource = "flag" | "env" | "dotenv";

export interface ServerConfig {
  /** Base URL with scheme, no trailing slash — e.g. https://abc.cloud.dittolive.app/<app-id> */
  baseUrl: string;
  /** API key (Bearer token). Never printed. */
  apiKey: string;
  /** API version for /store/execute (v5 default; v4 = legacy strict mode). */
  apiVersion: ApiVersion;
  /** Which layer each credential came from (reported by `server doctor`; never the values). */
  sources: { url: ConfigSource; apiKey: ConfigSource };
}

export interface ServerConfigFlags {
  url?: string;
  apiKey?: string;
  apiVersion?: string;
}

/** Parse a cwd `.env` file without touching process.env. Missing/unreadable → {}. */
export function readDotEnv(cwd: string = process.cwd()): Record<string, string> {
  try {
    const file = path.join(cwd, ".env");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return {};
    const parsed = parseEnv(fs.readFileSync(file, "utf8"));
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => e[1] !== undefined),
    );
  } catch {
    return {};
  }
}

/** First non-empty value from a list of candidate keys across flag/env/dotenv layers. */
function pick(
  flag: string | undefined,
  names: string[],
  env: NodeJS.ProcessEnv,
  dotEnv: Record<string, string>,
): { value: string; source: ConfigSource } | undefined {
  if (flag?.trim()) return { value: flag.trim(), source: "flag" };
  for (const name of names) {
    const v = env[name]?.trim();
    if (v) return { value: v, source: "env" };
  }
  for (const name of names) {
    const v = dotEnv[name]?.trim();
    if (v) return { value: v, source: "dotenv" };
  }
  return undefined;
}

/** Normalize the cloud URL endpoint: add https:// when scheme-less, drop trailing slashes, validate. */
export function normalizeBaseUrl(raw: string): string {
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ServerConfigError(
      `Invalid server URL "${raw}" — expected something like xxxx.cloud.dittolive.app/<app-id>`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ServerConfigError(`Invalid server URL "${raw}" — only http(s) URLs are supported`);
  }
  // Reject anything that would corrupt request paths or leak secrets into
  // printed URLs: userinfo, query strings, fragments.
  if (url.username || url.password) {
    throw new ServerConfigError(
      "Invalid server URL — credentials must not be embedded in the URL (use --api-key / DITTOSH_SERVER_API_KEY)",
    );
  }
  if (url.search || url.hash) {
    throw new ServerConfigError(
      "Invalid server URL — expected just the Cloud URL Endpoint (host + app id), no query string or fragment",
    );
  }
  // A bare trailing "?" or "#" parses as empty search/hash but survives in the
  // serialized URL and would misroute every request — strip unconditionally.
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function resolveApiVersion(raw: string | undefined): ApiVersion {
  if (raw === undefined) return "v5";
  if (raw === "v4" || raw === "v5") return raw;
  throw new ApiVersionError(`--api-version must be v4 or v5 — got "${raw}"`);
}

/**
 * Resolve the effective server config or throw ServerConfigError (exit 3)
 * with a message that names exactly what to set.
 */
export function resolveServerConfig(
  flags: ServerConfigFlags,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const dotEnv = readDotEnv(cwd);

  // Hint when a .env exists but yielded nothing — otherwise "no config" is
  // confusing when the file is right there (unreadable, or wrong var names).
  const dotEnvHint = fs.existsSync(path.join(cwd, ".env"))
    ? "\n(Note: a .env exists in the current directory but provided no usable DITTOSH_SERVER_* values — unreadable, or wrong variable names.)"
    : "";

  const rawUrl = pick(flags.url, ["DITTOSH_SERVER_URL", "DITTO_CLOUD_URL"], env, dotEnv);
  if (!rawUrl) {
    throw new ServerConfigError(
      "No Ditto Server URL configured. Set DITTOSH_SERVER_URL (shell or .env) or pass --url.\n" +
        'Find it in the portal: your app → "Connecting via HTTP" → Cloud URL Endpoint ' +
        `(looks like xxxx.cloud.dittolive.app/<app-id>).${dotEnvHint}`,
    );
  }

  const apiKey = pick(flags.apiKey, ["DITTOSH_SERVER_API_KEY", "DITTO_API_KEY"], env, dotEnv);
  if (!apiKey) {
    throw new ServerConfigError(
      "No Ditto Server API key configured. Set DITTOSH_SERVER_API_KEY (shell or .env) or pass --api-key.\n" +
        `Create one in the portal: your app → Auth → New API key.${dotEnvHint}`,
    );
  }

  return {
    baseUrl: normalizeBaseUrl(rawUrl.value),
    apiKey: apiKey.value,
    apiVersion: resolveApiVersion(flags.apiVersion),
    sources: { url: rawUrl.source, apiKey: apiKey.source },
  };
}
