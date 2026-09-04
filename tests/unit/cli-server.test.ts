import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServerGroup } from "../../src/cli/groups/server/index.js";
import type { FetchLike } from "../../src/server/client.js";

/**
 * Commander-level tests for `dittosh server`. A mock fetch is injected via the
 * group's deps so nothing touches the network; the DITTOSH_SERVER_* env vars
 * are scrubbed because tests/setup/env.ts loads the repo .env, which may hold
 * REAL credentials — these tests must stay hermetic either way.
 */

const SERVER_ENV_VARS = [
  "DITTOSH_SERVER_URL",
  "DITTOSH_SERVER_API_KEY",
  "DITTO_CLOUD_URL",
  "DITTO_API_KEY",
];

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let savedEnv: Record<string, string | undefined>;
let savedCwd: string;
let workDir: string;

beforeEach(async () => {
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  savedEnv = Object.fromEntries(SERVER_ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of SERVER_ENV_VARS) delete process.env[k];
  // server config reads a .env in the CWD — the repo root has one with real
  // credentials, so every test runs from an empty tmpdir to stay hermetic.
  const { tmpDataDir } = await import("../helpers/credentials.js");
  workDir = tmpDataDir("dittosh-cli-server-");
  savedCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(async () => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = undefined;
  process.chdir(savedCwd);
  const { rmrf } = await import("../helpers/credentials.js");
  rmrf(workDir);
  for (const k of SERVER_ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

interface CannedReply {
  status?: number;
  body?: unknown;
  text?: string;
}

function buildProgram(handler: (url: string, body?: unknown) => CannedReply = () => ({})) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body =
      typeof init.body === "string"
        ? (() => {
            try {
              return JSON.parse(init.body as string);
            } catch {
              return init.body;
            }
          })()
        : undefined;
    calls.push({ url, method: init.method, body });
    const reply = handler(url, body);
    return {
      status: reply.status ?? 200,
      statusText: "",
      headers: { get: () => "application/json" },
      text: async () => reply.text ?? JSON.stringify(reply.body ?? {}),
    };
  };
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerServerGroup(program.command("server"), { fetchImpl });
  return { program, calls };
}

const ENV = { DITTOSH_SERVER_URL: "https://mock.example/app", DITTOSH_SERVER_API_KEY: "key" };

async function run(program: Command, args: string[]) {
  try {
    await program.parseAsync(["node", "dittosh", ...args]);
  } catch (err) {
    // commander throws CommanderError for help/usage with exitOverride
    if (err instanceof Error && "exitCode" in err) {
      process.exitCode = (err as { exitCode: number }).exitCode === 0 ? 0 : 2;
    } else throw err;
  }
}

describe("server: config resolution through the CLI", () => {
  it("missing config → exit 3 with guidance", async () => {
    const { program } = buildProgram();
    await run(program, ["server", "execute", "SELECT 1"]);
    expect(process.exitCode).toBe(3);
    expect(stderr()).toContain("DITTOSH_SERVER_URL");
    expect(stdout()).toBe("");
  });

  it("--url/--api-key flags are honored", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { queryType: "select", items: [{ n: 1 }], mutatedDocumentIds: [] },
    }));
    await run(program, [
      "server",
      "execute",
      "SELECT 1",
      "--url",
      "flag.example/app",
      "--api-key",
      "flag-key",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.url).toBe("https://flag.example/app/api/v5/store/execute");
  });
});

describe("server execute: usage errors (exit 2, no network)", () => {
  it("rejects positional + -e together", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "SELECT 1", "-e", "SELECT 2"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("not both");
    expect(calls).toHaveLength(0);
  });

  it("rejects -f with a statement", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "SELECT 1", "-f", "x.sql"]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("rejects multiple statements in one argv", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "SELECT 1; SELECT 2"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("multiple statements");
    expect(calls).toHaveLength(0);
  });

  it("rejects garbage --args JSON", async () => {
    const { program } = buildProgram();
    await run(program, ["server", "execute", "SELECT 1", "--args", "{nope"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--args must be a JSON object");
  });

  it("rejects -o with a mutation", async () => {
    const { program } = buildProgram();
    Object.assign(process.env, ENV);
    await run(program, ["server", "execute", "DELETE FROM c", "-o", "x.json"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("row-producing");
  });

  it("rejects a bad --api-version (exit 2 — a bad flag VALUE is usage)", async () => {
    const { program, calls } = buildProgram();
    Object.assign(process.env, ENV);
    await run(program, ["server", "execute", "SELECT 1", "--api-version", "v9"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--api-version must be v4 or v5");
    expect(calls).toHaveLength(0);
  });

  it("rejects a bad --txn-id", async () => {
    const { program } = buildProgram();
    Object.assign(process.env, ENV);
    await run(program, ["server", "execute", "SELECT 1", "--txn-id", "abc"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--txn-id must be an integer");
  });

  it("no statement and TTY stdin → usage error", async () => {
    const { program, calls } = buildProgram();
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await run(program, ["server", "execute"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("No statement given");
    expect(calls).toHaveLength(0);
  });
});

describe("server execute: happy paths over mock HTTP", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("runs a SELECT and prints JSON rows when piped", async () => {
    const { program, calls } = buildProgram(() => ({
      body: {
        transactionId: 42,
        queryType: "select",
        items: [{ _id: "c1", name: "Ada" }],
        mutatedDocumentIds: [],
        warnings: [],
      },
    }));
    await run(program, ["server", "execute", "SELECT * FROM customers LIMIT 1"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout())).toEqual([{ _id: "c1", name: "Ada" }]);
    expect(calls[0]!.body).toEqual({ statement: "SELECT * FROM customers LIMIT 1" });
  });

  it("binds -p/--args parameters", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { queryType: "select", items: [], mutatedDocumentIds: [] },
    }));
    await run(program, [
      "server",
      "execute",
      "SELECT * FROM c WHERE x = :x AND y = :y",
      "-p",
      "x=1",
      "--args",
      '{"y":"two"}',
    ]);
    expect(calls[0]!.body).toEqual({
      statement: "SELECT * FROM c WHERE x = :x AND y = :y",
      args: { y: "two", x: 1 },
    });
  });

  it("strips a trailing semicolon", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { queryType: "select", items: [], mutatedDocumentIds: [] },
    }));
    await run(program, ["server", "execute", "SELECT 1;"]);
    expect(calls[0]!.body).toEqual({ statement: "SELECT 1" });
  });

  it("DQL error in the response → exit 1, message on stderr", async () => {
    const { program } = buildProgram(() => ({
      body: {
        queryType: "unknown",
        items: [],
        mutatedDocumentIds: [],
        error: { description: "syntax error" },
        warnings: [],
      },
    }));
    await run(program, ["server", "execute", "SELEC"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("syntax error");
  });

  it("HTTP 401 → exit 3", async () => {
    const { program } = buildProgram(() => ({ status: 401, body: { message: "unauthorized" } }));
    await run(program, ["server", "execute", "SELECT 1"]);
    expect(process.exitCode).toBe(3);
    expect(stderr()).toContain("unauthorized");
  });

  it("server HTTP 500 → exit 1", async () => {
    const { program } = buildProgram(() => ({ status: 500, body: { message: "boom" } }));
    await run(program, ["server", "execute", "SELECT 1"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("boom");
  });

  it("runs a -f batch, one call per statement, with a summary", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-batch-"));
    const file = path.join(dir, "b.sql");
    fs.writeFileSync(file, "SELECT 1;\nSELECT 2;\n");
    try {
      const { program, calls } = buildProgram(() => ({
        body: { queryType: "select", items: [], mutatedDocumentIds: [] },
      }));
      await run(program, ["server", "execute", "-f", file]);
      expect(calls).toHaveLength(2);
      expect(process.exitCode ?? 0).toBe(0);
      expect(stderr()).toContain("2 ok, 0 failed (of 2)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("batch stops on first failure without --continue-on-error", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-batch-"));
    const file = path.join(dir, "b.sql");
    fs.writeFileSync(file, "SELECT 1;\nBROKEN;\nSELECT 3;\n");
    try {
      const { program, calls } = buildProgram((_url, body) => {
        const stmt = (body as { statement?: string })?.statement ?? "";
        if (stmt.startsWith("BROKEN")) {
          return {
            body: {
              queryType: "unknown",
              items: [],
              mutatedDocumentIds: [],
              error: { description: "bad" },
              warnings: [],
            },
          };
        }
        return { body: { queryType: "select", items: [], mutatedDocumentIds: [] } };
      });
      await run(program, ["server", "execute", "-f", file]);
      expect(calls).toHaveLength(2);
      expect(process.exitCode).toBe(1);
      expect(stderr()).toContain("1 ok, 1 failed (of 3)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server remote-execute", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("requires SYNC CONTEXT (usage error without it)", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "remote-execute", "SELECT 1"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("SYNC CONTEXT");
    expect(calls).toHaveLength(0);
  });

  it("posts to /api/v5/sync/remote_execute", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { result: [{ peer: "pk", items: [{ a: 1 }] }] },
    }));
    await run(program, [
      "server",
      "remote-execute",
      "SYNC CONTEXT ( PEERS WHERE peerKeyString = 'pk' ) SELECT 1",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.url).toContain("/api/v5/sync/remote_execute");
  });
});

describe("server roles", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("roles list normalizes the bucketed shape", async () => {
    const { program } = buildProgram(() => ({
      body: {
        roles: {
          staff: [
            {
              _id: { name: "staff", version: "v1" },
              description: "old",
              collection_permissions: "none",
            },
            {
              _id: { name: "staff", version: "v2" },
              description: "new",
              collection_permissions: "read_only",
            },
          ],
        },
      },
    }));
    await run(program, ["server", "roles", "list"]);
    expect(process.exitCode ?? 0).toBe(0);
    const rows = JSON.parse(stdout());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "staff", version: "v2", description: "new" });
  });

  it("roles list normalizes the paged shape", async () => {
    const { program } = buildProgram(() => ({
      body: {
        roles: [{ _id: { name: "b", version: "v1" } }, { _id: { name: "a", version: "v1" } }],
        hasMore: false,
      },
    }));
    await run(program, ["server", "roles", "list"]);
    const rows = JSON.parse(stdout());
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["a", "b"]);
  });

  it("roles create validates --permissions", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "roles", "create", "staff", "--permissions", "[1,2]"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--permissions");
    expect(calls).toHaveLength(0);
  });

  it("roles create posts the doc envelope", async () => {
    const { program, calls } = buildProgram();
    await run(program, [
      "server",
      "roles",
      "create",
      "staff",
      "--description",
      "Store staff",
      "--permissions",
      "read_only",
      "--grant-remote-query",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.body).toEqual({
      name: "staff",
      doc: {
        roles_version: "v1-preview",
        description: "Store staff",
        collection_permissions: "read_only",
        grant_remote_query: true,
      },
    });
  });

  it("roles delete requires -y when non-interactive", async () => {
    const { program, calls } = buildProgram();
    const origIn = process.stdin.isTTY;
    const origErr = process.stderr.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      await run(program, ["server", "roles", "delete", "staff"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIn, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: origErr, configurable: true });
    }
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("roles delete -y issues the DELETE", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "roles", "delete", "staff", "-y"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/api/v4/auth/roles/staff");
  });
});

describe("server users", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("users list prints rows and a cursor hint", async () => {
    const { program } = buildProgram(() => ({
      body: {
        users: [{ userId: "auth0|1", roles: ["staff"], identityVersion: "v1" }],
        hasMore: true,
        cursor: "next-cursor",
      },
    }));
    await run(program, ["server", "users", "list"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout())).toEqual([
      { userId: "auth0|1", roles: ["staff"], identityVersion: "v1" },
    ]);
    expect(stderr()).toContain("--cursor next-cursor");
  });

  it("users set-roles patches and reports", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { identityVersion: "v2", transactionId: 12 },
    }));
    await run(program, ["server", "users", "set-roles", "auth0|1", "staff", "ops"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ roles: ["staff", "ops"] });
    expect(JSON.parse(stdout())).toMatchObject({ userId: "auth0|1", transactionId: 12 });
  });

  it("users delete -y issues the DELETE", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "users", "delete", "auth0|1", "-y"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/api/v4/auth/users/auth0%7C1");
  });
});

describe("server webhook-secrets", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("list prints secrets; empty object → empty table", async () => {
    const { program } = buildProgram(() => ({
      body: { secret: [{ secret: "s1", notBefore: "a", notAfter: "b" }] },
    }));
    await run(program, ["server", "webhook-secrets", "list", "--provider", "p1"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout())).toEqual([
      { secret: "s1", notBefore: "a", notAfter: "b", rotated: "" },
    ]);
  });

  it("create requires --provider and a parseable --not-after", async () => {
    const { program, calls } = buildProgram();
    await run(program, [
      "server",
      "webhook-secrets",
      "create",
      "--provider",
      "p1",
      "--not-after",
      "not-a-date",
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--not-after must be an ISO 8601 date");
    expect(calls).toHaveLength(0);
  });

  it("create posts and prints the new secret", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { secret: "newsecret", notBefore: "nb", notAfter: "2027-01-01T00:00:00Z" },
    }));
    await run(program, [
      "server",
      "webhook-secrets",
      "create",
      "--provider",
      "p1",
      "--not-after",
      "2027-01-01T00:00:00Z",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(stdout()).secret).toBe("newsecret");
  });

  it("rotate fails when --secret doesn't match an existing secret", async () => {
    const { program } = buildProgram(() => ({ body: {} })); // list → []
    await run(program, [
      "server",
      "webhook-secrets",
      "rotate",
      "--provider",
      "p1",
      "--secret",
      "nope",
      "--not-after",
      "2027-01-01T00:00:00Z",
    ]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("No webhook secret matching");
  });

  it("rotate patches with the looked-up secret object", async () => {
    const existing = { secret: "s1", notBefore: "a", notAfter: "b" };
    const { program, calls } = buildProgram((_url, body) => {
      if (body === undefined) return { body: { secret: [existing] } }; // GET list
      return { body: { secret: "new", notBefore: "x", notAfter: "y" } }; // PATCH
    });
    await run(program, [
      "server",
      "webhook-secrets",
      "rotate",
      "--provider",
      "p1",
      "--secret",
      "s1",
      "--not-after",
      "2027-01-01T00:00:00Z",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect((patch!.body as { rotate: unknown }).rotate).toEqual(existing);
  });

  it("delete -y removes the looked-up secret", async () => {
    const existing = { secret: "s1", notBefore: "a", notAfter: "b" };
    const { program, calls } = buildProgram((_url, body) => {
      if (body === undefined) return { body: { secret: [existing] } }; // GET list
      return { body: {} }; // DELETE
    });
    await run(program, [
      "server",
      "webhook-secrets",
      "delete",
      "--provider",
      "p1",
      "--secret",
      "s1",
      "-y",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    const del = calls.find((c) => c.method === "DELETE");
    expect((del!.body as { secret: string }).secret).toBe("s1");
    expect((del!.body as { provider: string }).provider).toBe("p1");
  });
});

describe("server attachment", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("get refuses binary on a TTY without -o", async () => {
    const { program, calls } = buildProgram();
    const origTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await run(program, ["server", "attachment", "get", "att1"]);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origTty, configurable: true });
    }
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("Refusing to write binary");
    expect(calls).toHaveLength(0);
  });
});
