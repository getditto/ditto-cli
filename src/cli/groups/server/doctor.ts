import {
  type FetchLike,
  PortalApiError,
  PortalClient,
  PortalConnectionError,
  PortalTimeoutError,
} from "../../../server/client.js";
import {
  type ConfigSource,
  resolveServerConfig,
  type ServerConfig,
  ServerConfigError,
} from "../../../server/config.js";

/**
 * `dittosh server doctor` — validate that the CLI has a working Ditto Server
 * configuration BEFORE a script depends on it: config resolvable, URL sane,
 * server reachable, API key accepted. Logic lives here (injectable) so unit
 * tests need no network; the command only renders.
 */

export interface ServerDoctorCheck {
  ok: boolean;
  label: string;
  detail: string;
}

export interface ServerDoctorOptions {
  url?: string;
  apiKey?: string;
  apiVersion?: string;
  /** Injectable for tests (no network). */
  fetchImpl?: FetchLike;
  /** Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests (cwd .env lookup). */
  cwd?: string;
}

const SOURCE_LABELS: Record<ConfigSource, string> = {
  flag: "flag",
  env: "shell env",
  dotenv: "cwd .env",
};

function skipped(label: string, why: string): ServerDoctorCheck {
  return { ok: false, label, detail: `skipped — ${why}` };
}

/** Run every check, collecting results; never throws for config/network/auth failures. */
export async function collectServerDoctorChecks(
  opts: ServerDoctorOptions = {},
): Promise<ServerDoctorCheck[]> {
  let config: ServerConfig;
  try {
    config = resolveServerConfig(
      { url: opts.url, apiKey: opts.apiKey, apiVersion: opts.apiVersion },
      opts.env,
      opts.cwd,
    );
  } catch (err) {
    if (err instanceof ServerConfigError) {
      return [
        { ok: false, label: "config", detail: err.message },
        skipped("connection", "no configuration"),
        skipped("auth", "no configuration"),
      ];
    }
    throw err;
  }

  const checks: ServerDoctorCheck[] = [
    {
      ok: true,
      label: "config",
      detail:
        `url ${config.baseUrl} (${SOURCE_LABELS[config.sources.url]}) · ` +
        `api key set (${SOURCE_LABELS[config.sources.apiKey]}) · api ${config.apiVersion}`,
    },
  ];

  // One probe answers both remaining checks. The statement must be valid DQL
  // (the Big Peer rejects "SELECT 1" — FROM is required) and cheap:
  // system:collections exists on every Ditto store.
  // Network failure → connection ✗. 401/403 → connection ✓, auth ✗.
  // Anything the server ANSWERED (even 400) proves the key was evaluated.
  const client = new PortalClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetchImpl: opts.fetchImpl,
  });
  const PROBE = "SELECT * FROM system:collections LIMIT 1";
  try {
    const res = await client.execute(PROBE, undefined, { version: config.apiVersion });
    checks.push({ ok: true, label: "connection", detail: `reached ${config.baseUrl}` });
    const dqlError = res.error?.description;
    checks.push({
      ok: true,
      label: "auth",
      detail: dqlError
        ? `API key accepted (probe returned a query note: ${dqlError})`
        : `API key accepted — probe query ran (transactionId ${res.transactionId ?? "?"})`,
    });
  } catch (err) {
    if (err instanceof PortalConnectionError || err instanceof PortalTimeoutError) {
      checks.push({ ok: false, label: "connection", detail: err.message });
      checks.push(
        skipped(
          "auth",
          err instanceof PortalTimeoutError ? "probe timed out" : "server unreachable",
        ),
      );
    } else if (err instanceof PortalApiError) {
      checks.push({ ok: true, label: "connection", detail: `reached ${config.baseUrl}` });
      if (err.status === 401 || err.status === 403) {
        checks.push({
          ok: false,
          label: "auth",
          detail: `${err.message} — check the API key and its permissions (portal → app → Auth)`,
        });
      } else if (err.status === 400) {
        // A 400 means the request was authenticated and parsed — the key works.
        checks.push({
          ok: true,
          label: "auth",
          detail: `API key accepted (server rejected the probe statement itself: ${err.message})`,
        });
      } else {
        checks.push({
          ok: false,
          label: "auth",
          detail: `${err.message} — server error; the key itself was not evaluated`,
        });
      }
    } else {
      throw err;
    }
  }

  return checks;
}
