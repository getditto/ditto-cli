import os from "node:os";

export interface RedactOptions {
  /** Home directory shown as `~` (default: os.homedir()). */
  home?: string;
  /** Values never written to a report (tokens, license strings). */
  secrets?: (string | undefined)[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build a redactor for diagnostic text: secrets → `[redacted]`, the home
 * directory → `~`. Short secrets (< 8 chars) are skipped: replacing them
 * would mangle ordinary words without protecting anything.
 */
export function makeRedactor(opts: RedactOptions = {}): (text: string) => string {
  const home = opts.home ?? os.homedir();
  const secrets = [
    ...new Set((opts.secrets ?? []).filter((s): s is string => !!s && s.length >= 8)),
  ]
    // Longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
  const secretRe = secrets.length > 0 ? new RegExp(secrets.map(escapeRe).join("|"), "g") : null;
  // Only a whole path component: `/Users/al` must not touch `/Users/alex`.
  const homeRe =
    home && home.length > 1 ? new RegExp(`${escapeRe(home)}(?=$|[\\\\/"'\\s:)])`, "g") : null;
  return (text) => {
    let out = text;
    if (secretRe) out = out.replace(secretRe, "[redacted]");
    if (homeRe) out = out.replace(homeRe, "~");
    return out;
  };
}

/** Env vars whose values are credentials: reports say only whether they're set. */
export const SECRET_ENV = [
  "OFFLINE_TOKEN",
  "DQL_OFFLINE_LICENSE",
  "DATABASE_ID",
  "DITTO_APP_ID",
  "DITTOSH_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

/** Names that look like credentials (e.g. a future DITTOSH_*_TOKEN), hidden too. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|LICENSE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTH/i;

/** True for an env var whose value must never appear in a report. */
export function isSecretEnv(name: string): boolean {
  return SECRET_ENV.includes(name) || SECRET_NAME.test(name);
}

/** Values of every credential-like env var, for the redactor to scrub anywhere. */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v && isSecretEnv(k))
    .map(([, v]) => v as string);
}
