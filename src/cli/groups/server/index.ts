import chalk from "chalk";
import type { Command } from "commander";
import { ApiVersionError } from "../../../server/config.js";
import { registerAttachmentCommands } from "./attachments.js";
import type { ServerDeps } from "./common.js";
import { addServerOpts } from "./common.js";
import { collectServerDoctorChecks } from "./doctor.js";
import { registerRbacCommands } from "./rbac.js";
import { registerStoreCommands } from "./store.js";
import { registerWebhookCommands } from "./webhooks.js";

const GROUP_HELP = `
Query and manage Ditto Server (the Big Peer behind your app) over its HTTP
RPC API — the same API the portal's DQL editor uses.

Configuration (checked in this order — first hit wins):
  1. flags:        --url / --api-key
  2. shell env:    DITTOSH_SERVER_URL / DITTOSH_SERVER_API_KEY
  3. .env in cwd:  DITTOSH_SERVER_URL=… and DITTOSH_SERVER_API_KEY=…
  (aliases from the Ditto docs also work: DITTO_CLOUD_URL / DITTO_API_KEY)

Find the URL in the portal: your app → "Connecting via HTTP" → Cloud URL
Endpoint (looks like xxxx.cloud.dittolive.app/<app-id>). Create API keys under
your app → Auth → New API key.

Layers mix per key: a cwd .env URL + a shell-env API key sends that key to the
.env's host. Run "dittosh server doctor" to see where each value came from.

Endpoints covered (public docs + portal client):
  execute / remote-execute  DQL against the server / connected peers
  attachment upload/get     ATTACHMENT blobs
  roles / users             RBAC (undocumented; portal wire shapes)
  webhook-secrets           auth webhook HMAC secrets (undocumented)
  doctor                    validate URL + API key before scripting

(The legacy pre-DQL store API — find/findbyid/count/write — is deliberately
not supported; 'server execute' runs full DQL, including INSERT/UPDATE/DELETE.)

Exit codes: 0 ok · 1 query/API error · 2 usage · 3 config/auth/connection.`;

export function registerServerGroup(server: Command, deps: ServerDeps = {}): void {
  server
    .description("Query and manage Ditto Server over the portal HTTP API")
    .addHelpText("after", GROUP_HELP)
    .action(() => {
      server.help();
    });

  registerStoreCommands(server, deps);
  registerAttachmentCommands(server, deps);
  registerRbacCommands(server, deps);
  registerWebhookCommands(server, deps);

  addServerOpts(
    server
      .command("doctor")
      .description("Validate the server URL and API key (probes with a trivial DQL query)")
      .option("--api-version <version>", "v5 (default) or v4 — the probe uses this API version"),
  )
    .addHelpText(
      "after",
      `
Checks, in order:
  config      URL + API key resolvable (and where they came from)
  connection  the server answers at all
  auth        the API key is accepted (probes with SELECT * FROM system:collections LIMIT 1)

Exit codes: 0 all checks pass · 3 any check failed.

Example:
  dittosh server doctor
  dittosh server doctor --url xxxx.cloud.dittolive.app/<app-id> --api-key …
`,
    )
    .action(async (opts: { url?: string; apiKey?: string; apiVersion?: string }) => {
      let checks: Awaited<ReturnType<typeof collectServerDoctorChecks>>;
      try {
        checks = await collectServerDoctorChecks({
          url: opts.url,
          apiKey: opts.apiKey,
          apiVersion: opts.apiVersion,
          fetchImpl: deps.fetchImpl,
        });
      } catch (err) {
        // A bad flag value (--api-version) is a usage error, not a config report.
        if (err instanceof ApiVersionError) {
          console.error(chalk.red(err.message));
          process.exitCode = err.exitCode;
          return;
        }
        throw err;
      }
      for (const c of checks) {
        console.log(`${c.ok ? chalk.green("✓") : chalk.red("✗")} ${c.label} — ${c.detail}`);
      }
      const failures = checks.filter((c) => !c.ok).length;
      process.exitCode = failures === 0 ? 0 : 3;
    });
}
