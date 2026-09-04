import chalk from "chalk";
import type { Command } from "commander";
import { ParamError, parsePositiveInt, resolveArgsSource } from "../../../query/params.js";
import { FormatError, resolveFormat } from "../../../render/output.js";
import type { PortalUser, RoleDoc } from "../../../server/client.js";
import { emitRows } from "../../../server/run.js";
import { note } from "../dql/run.js";
import {
  addServerOpts,
  confirmDestructive,
  connect,
  parseJsonFlag,
  type ServerDeps,
  withServerErrors,
} from "./common.js";

/**
 * RBAC endpoints used by the portal (undocumented publicly — shapes from
 * cloud-services/portal/core/src/api/rpcClient.ts):
 *   GET/POST /api/v4/auth/roles, DELETE /api/v4/auth/roles/{name}
 *   GET /api/v4/auth/users, PATCH/DELETE /api/v4/auth/users/{userId}
 */

interface ServerOnlyOpts {
  url?: string;
  apiKey?: string;
}

export interface RolesPage {
  rows: Record<string, unknown>[];
  hasMore: boolean;
  cursor?: string;
}

/** GET /roles answers two shapes: bucketed {roles:{name:[docs]}} or paged {roles:[docs],hasMore,cursor}. */
export function normalizeRolesPage(data: unknown): RolesPage {
  if (typeof data !== "object" || data === null) return { rows: [], hasMore: false };
  const envelope = data as { roles?: unknown; hasMore?: unknown; cursor?: unknown };
  const roles = envelope.roles;
  const cursor =
    typeof envelope.cursor === "string" && envelope.cursor ? envelope.cursor : undefined;
  let docs: RoleDoc[] = [];
  if (Array.isArray(roles)) {
    docs = roles as RoleDoc[];
    // The paged shape is the only one that can be truncated — surface it.
    const rows = docs.map(roleRow).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { rows, hasMore: envelope.hasMore === true, cursor };
  }
  if (typeof roles === "object" && roles !== null) {
    // Bucketed: keep the newest version. UUIDv7s compare in creation order by
    // codepoint (matching the portal) — not localeCompare (locale-dependent).
    docs = Object.values(roles)
      .map((versions) =>
        Array.isArray(versions) && versions.length > 0
          ? ([...versions]
              .sort((a, b) => {
                const av = String(a?._id?.version ?? "");
                const bv = String(b?._id?.version ?? "");
                return av < bv ? -1 : av > bv ? 1 : 0;
              })
              .at(-1) as RoleDoc)
          : undefined,
      )
      .filter((d): d is RoleDoc => d !== undefined);
  }
  const rows = docs.map(roleRow).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { rows, hasMore: false };
}

function roleRow(d: RoleDoc): Record<string, unknown> {
  return {
    name: d?._id?.name,
    version: d?._id?.version,
    description: d?.description ?? "",
    collection_permissions: d?.collection_permissions ?? "none",
    grant_remote_query: d?.grant_remote_query ?? false,
  };
}

/** Kept for direct unit tests — rows only. */
export function normalizeRoles(data: unknown): Record<string, unknown>[] {
  return normalizeRolesPage(data).rows;
}

/** roles stay a real array — JSON consumers must not get a comma-joined string. */
function normalizeUsers(users: PortalUser[] | undefined): Record<string, unknown>[] {
  return (users ?? []).map((u) => ({
    userId: u.userId,
    roles: u.roles ?? [],
    identityVersion: u.identityVersion ?? "",
  }));
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function registerRbacCommands(server: Command, deps: ServerDeps = {}): void {
  // ---- roles ---------------------------------------------------------------

  const roles = server
    .command("roles")
    .description("Manage Big Peer RBAC roles (portal API, undocumented)")
    .addHelpText(
      "after",
      `
Roles gate what authenticated users may read/write. Wire shapes here come from
the portal's own client — the public docs don't cover these endpoints.
`,
    );

  addServerOpts(
    roles
      .command("list")
      .description("List roles (GET /api/v4/auth/roles)")
      .option("--cursor <cursor>", "continue from a previous page (cursor-paged deployments)")
      .option("--format <format>", "table | json | csv | markdown | html | vertical")
      .option("--max-rows <n>", "maximum rows to display", "10000")
      .option("--no-pager", "never pipe results through $PAGER/less"),
  )
    .addHelpText(
      "after",
      `
Examples:
  dittosh server roles list
  dittosh server roles list --cursor <from-previous-page>
`,
    )
    .action(
      withServerErrors(
        async (
          opts: ServerOnlyOpts & {
            cursor?: string;
            format?: string;
            maxRows?: string;
            pager?: boolean;
          },
        ) => {
          // Usage validation BEFORE any network I/O (exit 2, no request).
          let maxRows: number;
          try {
            if (opts.format !== undefined) resolveFormat(opts.format);
            maxRows = parsePositiveInt(opts.maxRows, "--max-rows", 10_000);
          } catch (err) {
            if (err instanceof ParamError || err instanceof FormatError) {
              console.error(chalk.red(err.message));
              process.exitCode = err.exitCode;
              return;
            }
            throw err;
          }
          const conn = connect(opts, deps);
          if (!conn) return;
          const page = normalizeRolesPage(await conn.client.listRoles({ cursor: opts.cursor }));
          const r = emitRows(
            page.rows,
            { format: opts.format, maxRows, maxRowsExplicit: false, pager: opts.pager },
            0,
          );
          if (!r.ok) process.exitCode = 1;
          if (page.hasMore && page.cursor) {
            note(`(more pages — continue with --cursor ${page.cursor})`);
          }
        },
      ),
    );

  addServerOpts(
    roles
      .command("create")
      .description("Create or replace a role (POST /api/v4/auth/roles)")
      .argument("<name>", "role name")
      .option("--description <text>", "human-readable description", "")
      .option(
        "--permissions <json>",
        "blanket ('none'|'read_only'|'write_only'|'read_and_write') or a per-collection map ('@file' reads a file)",
      )
      .option("--grant-remote-query", "allow members to run remote queries", false),
  )
    .addHelpText(
      "after",
      `
Request body (server assigns the role version):
  { "name": "<name>",
    "doc": { "roles_version": "v1-preview", "description": "...",
             "collection_permissions": <permissions>, "grant_remote_query": bool } }

POST creates OR REPLACES the role. Omitted flags send explicit defaults
("none" permissions, no remote query) — matching the portal's behavior.

--permissions is either a blanket string or a map of collection → read/write
sides, each side true | false | a list of DQL WHERE clauses (any match grants):
  --permissions read_only
  --permissions '{"cars": {"read": true, "write": ["_id == \\'car-1\\'"]}}'
  --permissions @role.json

Examples:
  dittosh server roles create staff --description "Store staff" --permissions read_only
  dittosh server roles create ops --permissions @ops-role.json --grant-remote-query
`,
    )
    .action(
      withServerErrors(
        async (
          name: string,
          opts: ServerOnlyOpts & {
            description?: string;
            permissions?: string;
            grantRemoteQuery?: boolean;
          },
        ) => {
          let permissions: unknown;
          try {
            if (opts.permissions !== undefined) {
              const BLANKETS = ["none", "read_only", "write_only", "read_and_write"];
              const raw = opts.permissions.startsWith("@")
                ? await resolveArgsSource(opts.permissions, readStdinText, "--permissions")
                : opts.permissions;
              // Bare blanket strings are accepted as-is; anything else must be a JSON map.
              const parsed = BLANKETS.includes(raw!.trim())
                ? raw!.trim()
                : parseJsonFlag(raw!, "--permissions");
              if (
                typeof parsed !== "string" &&
                (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
              ) {
                throw new ParamError(
                  "--permissions must be 'none'|'read_only'|'write_only'|'read_and_write' or a JSON object map",
                );
              }
              permissions = parsed;
            }
          } catch (err) {
            if (err instanceof ParamError) {
              console.error(chalk.red(err.message));
              process.exitCode = err.exitCode;
              return;
            }
            throw err;
          }
          const conn = connect(opts, deps);
          if (!conn) return;
          await conn.client.createRole({
            name,
            description: opts.description,
            collectionPermissions: permissions,
            grantRemoteQuery: opts.grantRemoteQuery ? true : undefined,
          });
          console.error(chalk.dim(`Role "${name}" created`));
        },
      ),
    );

  addServerOpts(
    roles
      .command("delete")
      .description("Delete every version of a role (DELETE /api/v4/auth/roles/{name})")
      .argument("<name>", "role name")
      .option("-y, --yes", "confirm without prompting", false),
  )
    .addHelpText(
      "after",
      `
Example:
  dittosh server roles delete staff -y
`,
    )
    .action(
      withServerErrors(async (name: string, opts: ServerOnlyOpts & { yes?: boolean }) => {
        const conn = connect(opts, deps);
        if (!conn) return;
        // Confirm only after config resolves — no point prompting when the
        // command can't act anyway.
        if (!(await confirmDestructive(`Delete role "${name}"?`, opts.yes))) return;
        await conn.client.deleteRole(name);
        console.error(chalk.dim(`Role "${name}" deleted`));
      }),
    );

  // ---- users ---------------------------------------------------------------

  const users = server
    .command("users")
    .description("Manage app users and their roles (portal API, undocumented)")
    .addHelpText(
      "after",
      `
A user is an identity-provider subject (e.g. auth0|1234) provisioned via the
auth webhook. These endpoints list users and replace their role sets.
`,
    );

  addServerOpts(
    users
      .command("list")
      .description("List users (GET /api/v4/auth/users)")
      .option("--user-id <id>", "filter to one user")
      .option("--limit <n>", "page size")
      .option("--cursor <cursor>", "continue from a previous page")
      .option("--format <format>", "table | json | csv | markdown | html | vertical")
      .option("--max-rows <n>", "maximum rows to display", "10000")
      .option("--no-pager", "never pipe results through $PAGER/less"),
  )
    .addHelpText(
      "after",
      `
Query params: userId (filter), cursor, limit.
Response: { "users": [ {"userId", "roles": […], "identityVersion"} ], "hasMore": bool, "cursor" }

Example:
  dittosh server users list --limit 50
  dittosh server users list --cursor <from-previous-page>
`,
    )
    .action(
      withServerErrors(
        async (
          opts: ServerOnlyOpts & {
            userId?: string;
            limit?: string;
            cursor?: string;
            format?: string;
            maxRows?: string;
            pager?: boolean;
          },
        ) => {
          // Usage validation BEFORE any network I/O (exit 2, no request).
          let limit: number | undefined;
          let maxRows: number;
          try {
            limit =
              opts.limit === undefined
                ? undefined
                : parsePositiveInt(opts.limit, "--limit", 0, { min: 0 });
            if (opts.format !== undefined) resolveFormat(opts.format);
            maxRows = parsePositiveInt(opts.maxRows, "--max-rows", 10_000);
          } catch (err) {
            if (err instanceof ParamError || err instanceof FormatError) {
              console.error(chalk.red(err.message));
              process.exitCode = err.exitCode;
              return;
            }
            throw err;
          }
          const conn = connect(opts, deps);
          if (!conn) return;
          const page = await conn.client.listUsers({
            userId: opts.userId,
            cursor: opts.cursor,
            limit,
          });
          const r = emitRows(
            normalizeUsers(page.users),
            {
              format: opts.format,
              maxRows,
              maxRowsExplicit: false,
              pager: opts.pager,
            },
            0,
          );
          if (!r.ok) process.exitCode = 1;
          if (page.hasMore && page.cursor) {
            note(`(more pages — continue with --cursor ${page.cursor})`);
          }
        },
      ),
    );

  addServerOpts(
    users
      .command("set-roles")
      .description("Replace a user's entire role set (PATCH /api/v4/auth/users/{userId})")
      .argument("<user-id>", "user ID (IdP subject, e.g. auth0|1234)")
      .argument("[roles...]", "role names; none clears the user's roles"),
  )
    .addHelpText(
      "after",
      `
Request body: { "roles": ["<name>", …] } — REPLACES the user's whole set.

Examples:
  dittosh server users set-roles "auth0|1234" staff ops
  dittosh server users set-roles "auth0|1234"          # clears all roles
`,
    )
    .action(
      withServerErrors(async (userId: string, rolesList: string[], opts: ServerOnlyOpts) => {
        const conn = connect(opts, deps);
        if (!conn) return;
        const res = await conn.client.setUserRoles(userId, rolesList);
        console.log(
          JSON.stringify(
            {
              userId,
              roles: rolesList,
              identityVersion: res.identityVersion,
              transactionId: res.transactionId,
            },
            null,
            2,
          ),
        );
      }),
    );

  addServerOpts(
    users
      .command("delete")
      .description("Remove a user from the app (DELETE /api/v4/auth/users/{userId})")
      .argument("<user-id>", "user ID (IdP subject, e.g. auth0|1234)")
      .option("-y, --yes", "confirm without prompting", false),
  )
    .addHelpText(
      "after",
      `
Example:
  dittosh server users delete "auth0|1234" -y
`,
    )
    .action(
      withServerErrors(async (userId: string, opts: ServerOnlyOpts & { yes?: boolean }) => {
        const conn = connect(opts, deps);
        if (!conn) return;
        if (!(await confirmDestructive(`Remove user "${userId}" from the app?`, opts.yes))) return;
        await conn.client.deleteUser(userId);
        console.error(chalk.dim(`User "${userId}" removed`));
      }),
    );
}
