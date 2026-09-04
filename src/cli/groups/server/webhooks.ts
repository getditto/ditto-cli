import chalk from "chalk";
import type { Command } from "commander";
import { ParamError, parsePositiveInt } from "../../../query/params.js";
import { FormatError, resolveFormat } from "../../../render/output.js";
import type { WebhookSecret } from "../../../server/client.js";
import { emitRows } from "../../../server/run.js";
import {
  addServerOpts,
  confirmDestructive,
  connect,
  type ServerDeps,
  withServerErrors,
} from "./common.js";

/**
 * Auth webhook secrets (HMAC-SHA256 signature verification for auth webhooks) —
 * GET/POST/PATCH/DELETE /api/v4/auth/webhook/secret. Undocumented publicly;
 * shapes from the portal client. DELETE and PATCH need the full secret object,
 * so the CLI looks it up by --secret before writing.
 */

interface ServerOnlyOpts {
  url?: string;
  apiKey?: string;
}

function requireProvider(raw: string | undefined): string {
  const provider = raw?.trim();
  if (!provider) throw new ParamError("--provider is required (the auth webhook provider name)");
  return provider;
}

function requireIsoDate(raw: string | undefined, flag: string): string {
  const value = raw?.trim();
  if (!value) throw new ParamError(`${flag} is required (ISO 8601, e.g. 2026-12-31T00:00:00Z)`);
  if (Number.isNaN(Date.parse(value))) {
    throw new ParamError(`${flag} must be an ISO 8601 date, got: "${value}"`);
  }
  return value;
}

function requireSecret(raw: string | undefined): string {
  const secret = raw?.trim();
  if (!secret) throw new ParamError("--secret is required (the base64 secret to operate on)");
  return secret;
}

/** Look up one secret object by value; null (caller sets exit 1) when absent. */
function findSecret(
  secrets: WebhookSecret[],
  provider: string,
  secret: string,
): WebhookSecret | null {
  const matches = secrets.filter((s) => s.secret === secret);
  if (matches.length === 0) {
    console.error(
      chalk.red(`No webhook secret matching --secret for provider "${provider}" — list them first`),
    );
    return null;
  }
  return matches[0]!;
}

function printUsageError(err: unknown): boolean {
  if (err instanceof ParamError) {
    console.error(chalk.red(err.message));
    process.exitCode = err.exitCode;
    return true;
  }
  return false;
}

export function registerWebhookCommands(server: Command, deps: ServerDeps = {}): void {
  const webhooks = server
    .command("webhook-secrets")
    .description("Manage auth webhook HMAC secrets (portal API, undocumented)")
    .addHelpText(
      "after",
      `
Secrets sign requests to your auth webhook (HMAC-SHA256). Each secret has a
validity window [notBefore, notAfter]; rotation issues a new secret while the
old one stays valid until its notAfter.
`,
    );

  addServerOpts(
    webhooks
      .command("list")
      .description("List a provider's secrets (GET /api/v4/auth/webhook/secret?provider=…)")
      .requiredOption("--provider <name>", "auth webhook provider name")
      .option("--format <format>", "table | json | csv | markdown | html | vertical")
      .option("--max-rows <n>", "maximum rows to display", "10000")
      .option("--no-pager", "never pipe results through $PAGER/less"),
  )
    .addHelpText(
      "after",
      `
Response entries: { "secret": "<base64>", "notBefore": "<rfc3339>",
                    "notAfter": "<rfc3339>", "rotated": "<rfc3339, if rotated>" }

Example:
  dittosh server webhook-secrets list --provider my-auth-webhook
`,
    )
    .action(
      withServerErrors(
        async (
          opts: ServerOnlyOpts & {
            provider?: string;
            format?: string;
            maxRows?: string;
            pager?: boolean;
          },
        ) => {
          let provider: string;
          let maxRows: number;
          try {
            provider = requireProvider(opts.provider);
            if (opts.format !== undefined) resolveFormat(opts.format);
            maxRows = parsePositiveInt(opts.maxRows, "--max-rows", 10_000);
          } catch (err) {
            if (printUsageError(err)) return;
            if (err instanceof FormatError) {
              console.error(chalk.red(err.message));
              process.exitCode = err.exitCode;
              return;
            }
            throw err;
          }
          const conn = connect(opts, deps);
          if (!conn) return;
          const secrets = await conn.client.listWebhookSecrets(provider);
          const r = emitRows(
            secrets.map((s) => ({
              secret: s.secret,
              notBefore: s.notBefore,
              notAfter: s.notAfter,
              rotated: s.rotated ?? "",
            })),
            { format: opts.format, maxRows, maxRowsExplicit: false, pager: opts.pager },
            0,
          );
          if (!r.ok) process.exitCode = 1;
        },
      ),
    );

  addServerOpts(
    webhooks
      .command("create")
      .description("Generate a new secret (POST /api/v4/auth/webhook/secret)")
      .requiredOption("--provider <name>", "auth webhook provider name")
      .requiredOption("--not-after <iso>", "expiry, ISO 8601 (e.g. 2026-12-31T00:00:00Z)"),
  )
    .addHelpText(
      "after",
      `
Request body: { "provider": "<name>", "notBefore": <now>, "notAfter": "<iso>" }
Response:     { "secret": "<base64>", "notBefore": …, "notAfter": … }

Example:
  dittosh server webhook-secrets create --provider my-auth-webhook --not-after 2027-01-01T00:00:00Z
`,
    )
    .action(
      withServerErrors(async (opts: ServerOnlyOpts & { provider?: string; notAfter?: string }) => {
        let provider: string;
        let notAfter: string;
        try {
          provider = requireProvider(opts.provider);
          notAfter = requireIsoDate(opts.notAfter, "--not-after");
        } catch (err) {
          if (printUsageError(err)) return;
          throw err;
        }
        const conn = connect(opts, deps);
        if (!conn) return;
        const secret = await conn.client.createWebhookSecret(provider, notAfter);
        console.log(JSON.stringify(secret, null, 2));
      }),
    );

  addServerOpts(
    webhooks
      .command("rotate")
      .description("Rotate a secret: mark the old one rotated, issue a new one (PATCH)")
      .requiredOption("--provider <name>", "auth webhook provider name")
      .requiredOption("--secret <base64>", "the existing secret to rotate")
      .requiredOption("--not-after <iso>", "expiry for the NEW secret, ISO 8601"),
  )
    .addHelpText(
      "after",
      `
Request body: { "provider": "<name>",
                "rotate": { "secret", "notBefore", "notAfter" },   // existing secret
                "new":    { "notBefore": <now>, "notAfter": "<iso>" } }

The CLI fetches the existing secret's validity window for you — pass only its value:
  dittosh server webhook-secrets rotate --provider my-auth-webhook \\
    --secret "$(…)" --not-after 2027-01-01T00:00:00Z
`,
    )
    .action(
      withServerErrors(
        async (
          opts: ServerOnlyOpts & { provider?: string; secret?: string; notAfter?: string },
        ) => {
          let provider: string;
          let secretValue: string;
          let notAfter: string;
          try {
            provider = requireProvider(opts.provider);
            secretValue = requireSecret(opts.secret);
            notAfter = requireIsoDate(opts.notAfter, "--not-after");
          } catch (err) {
            if (printUsageError(err)) return;
            throw err;
          }
          const conn = connect(opts, deps);
          if (!conn) return;
          const existing = findSecret(
            await conn.client.listWebhookSecrets(provider),
            provider,
            secretValue,
          );
          if (!existing) {
            process.exitCode = 1;
            return;
          }
          const rotated = await conn.client.rotateWebhookSecret(provider, existing, notAfter);
          console.log(JSON.stringify(rotated, null, 2));
        },
      ),
    );

  addServerOpts(
    webhooks
      .command("delete")
      .description("Delete a secret (DELETE /api/v4/auth/webhook/secret)")
      .requiredOption("--provider <name>", "auth webhook provider name")
      .requiredOption("--secret <base64>", "the secret to delete")
      .option("-y, --yes", "confirm without prompting", false),
  )
    .addHelpText(
      "after",
      `
DELETE requires the full secret object — the CLI looks it up from --secret.

Example:
  dittosh server webhook-secrets delete --provider my-auth-webhook --secret "$(…)" -y
`,
    )
    .action(
      withServerErrors(
        async (opts: ServerOnlyOpts & { provider?: string; secret?: string; yes?: boolean }) => {
          let provider: string;
          let secretValue: string;
          try {
            provider = requireProvider(opts.provider);
            secretValue = requireSecret(opts.secret);
          } catch (err) {
            if (printUsageError(err)) return;
            throw err;
          }
          const conn = connect(opts, deps);
          if (!conn) return;
          const existing = findSecret(
            await conn.client.listWebhookSecrets(provider),
            provider,
            secretValue,
          );
          if (!existing) {
            process.exitCode = 1;
            return;
          }
          // Confirm only once we know the secret exists and we can act on it.
          if (
            !(await confirmDestructive(`Delete this webhook secret for "${provider}"?`, opts.yes))
          ) {
            return;
          }
          await conn.client.deleteWebhookSecret({ ...existing, provider });
          console.error(chalk.dim("Webhook secret deleted"));
        },
      ),
    );
}
