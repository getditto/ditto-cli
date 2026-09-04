import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServerGroup } from "../../src/cli/groups/server/index.js";
import type { FetchLike } from "../../src/server/client.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

/**
 * Branch-coverage companion to cli-server.test.ts: the usage-validation paths
 * (exit 2 before any network) and the per-command happy paths that file
 * doesn't already exercise.
 */

const SERVER_ENV_VARS = [
  "DITTOSH_SERVER_URL",
  "DITTOSH_SERVER_API_KEY",
  "DITTO_CLOUD_URL",
  "DITTO_API_KEY",
];

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;
let savedEnv: Record<string, string | undefined>;
let savedCwd: string;
let workDir: string;

beforeEach(() => {
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.exitCode = undefined;
  savedEnv = Object.fromEntries(SERVER_ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of SERVER_ENV_VARS) delete process.env[k];
  workDir = tmpDataDir("dittosh-cli-server2-");
  savedCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  writeSpy.mockRestore();
  process.exitCode = undefined;
  process.chdir(savedCwd);
  rmrf(workDir);
  for (const k of SERVER_ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

const ENV = { DITTOSH_SERVER_URL: "https://mock.example/app", DITTOSH_SERVER_API_KEY: "key" };

interface CannedReply {
  status?: number;
  body?: unknown;
  text?: string;
}

function buildProgram(handler: (url: string, body?: unknown) => CannedReply = () => ({})) {
  const calls: { url: string; method: string; body?: unknown; authorization?: string }[] = [];
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
    calls.push({ url, method: init.method, body, authorization: init.headers.Authorization });
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

async function run(program: Command, args: string[]) {
  try {
    await program.parseAsync(["node", "dittosh", ...args]);
  } catch (err) {
    if (err instanceof Error && "exitCode" in err) {
      process.exitCode = (err as { exitCode: number }).exitCode === 0 ? 0 : 2;
    } else throw err;
  }
}

function withStdinTTY(isTTY: boolean, fn: () => Promise<void>) {
  return async () => {
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
    try {
      await fn();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  };
}

describe("server: bare group prints help", () => {
  it("dittosh server → help, exit 0", async () => {
    const { program } = buildProgram();
    await run(program, ["server"]);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("server execute: more usage validation", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("--args - with a TTY stdin → exit 2", async () => {
    const { program, calls } = buildProgram();
    await withStdinTTY(true, async () => {
      await run(program, ["server", "execute", "SELECT 1", "--args", "-"]);
    })();
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("stdin is a terminal");
    expect(calls).toHaveLength(0);
  });

  it("--args - without a statement → exit 2", async () => {
    const { program, calls } = buildProgram();
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await run(program, ["server", "execute", "--args", "-"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("consumes stdin");
    expect(calls).toHaveLength(0);
  });

  it("-f with an unreadable file → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "-f", path.join(workDir, "nope.sql")]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("Cannot read file");
    expect(calls).toHaveLength(0);
  });

  it('-f "" → exit 2', async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "-f", " "]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("-f/--file requires a path");
    expect(calls).toHaveLength(0);
  });

  it("-f with an empty file → exit 2", async () => {
    const { program, calls } = buildProgram();
    const file = path.join(workDir, "empty.sql");
    fs.writeFileSync(file, "-- only a comment\n");
    await run(program, ["server", "execute", "-f", file]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("No statements in");
    expect(calls).toHaveLength(0);
  });

  it("-f with multiple statements + -o → exit 2", async () => {
    const { program, calls } = buildProgram();
    const file = path.join(workDir, "two.sql");
    fs.writeFileSync(file, "SELECT 1;\nSELECT 2;\n");
    await run(program, ["server", "execute", "-f", file, "-o", "out.json"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--out is only supported for a single statement");
    expect(calls).toHaveLength(0);
  });

  it("-o to a bogus path → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, [
      "server",
      "execute",
      "SELECT 1",
      "-o",
      path.join(workDir, "nope", "x.json"),
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("Cannot write");
    expect(calls).toHaveLength(0);
  });

  it("unterminated single statement is sent as-is (no trailing-; rule over HTTP)", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { queryType: "unknown", items: [], mutatedDocumentIds: [], error: {}, warnings: [] },
    }));
    await run(program, ["server", "execute", "SELECT 1 garbage here"]);
    expect(process.exitCode ?? 0).toBe(0); // single unterminated statement is sent as-is
    expect(calls).toHaveLength(1);
  });

  it("whitespace-only statement → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "   -- just a comment"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("No statement given");
    expect(calls).toHaveLength(0);
  });

  it("bad --format → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "SELECT 1", "--format", "yaml"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--format must be one of");
    expect(calls).toHaveLength(0);
  });

  it("batch --continue-on-error runs all statements", async () => {
    const file = path.join(workDir, "b.sql");
    fs.writeFileSync(file, "SELECT 1;\nBROKEN;\nSELECT 3;\n");
    const { program, calls } = buildProgram((_url, body) => {
      const stmt = (body as { statement?: string })?.statement ?? "";
      if (stmt === "BROKEN") {
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
    await run(program, ["server", "execute", "-f", file, "--continue-on-error"]);
    expect(calls).toHaveLength(3);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("2 ok, 1 failed (of 3)");
  });

  it("batch: a thrown HTTP error counts as failed and stops", async () => {
    const file = path.join(workDir, "b.sql");
    fs.writeFileSync(file, "SELECT 1;\nSELECT 2;\n");
    const { program, calls } = buildProgram(() => ({ status: 500, body: { message: "boom" } }));
    await run(program, ["server", "execute", "-f", file]);
    expect(calls).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("0 ok, 1 failed (of 2)");
  });

  it("the exec alias works", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { queryType: "select", items: [], mutatedDocumentIds: [] },
    }));
    await run(program, ["server", "exec", "SELECT 1"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("server remote-execute: usage validation", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("bad --args → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, [
      "server",
      "remote-execute",
      "SYNC CONTEXT ( PEERS WHERE peerKeyString = 'x' ) SELECT 1",
      "--args",
      "{no",
    ]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("server attachment commands", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("upload: missing file → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "attachment", "upload", "no-such-file.bin"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("Cannot read file");
    expect(calls).toHaveLength(0);
  });

  it("upload posts multipart and prints {id, len}", async () => {
    const file = path.join(workDir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const { program, calls } = buildProgram(() => ({ body: { id: "att-9", len: 4 } }));
    await run(program, ["server", "attachment", "upload", file]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.url).toContain("/api/v4/attachments/upload");
    expect(JSON.parse(stdout())).toEqual({ id: "att-9", len: 4 });
  });

  it("get -o writes the bytes to a file", async () => {
    const { program } = buildProgram(() => ({ text: "BINARY" }));
    const out = path.join(workDir, "att.bin");
    await run(program, ["server", "attachment", "get", "att-1", "-o", out]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(out).toString("binary")).toBe("BINARY");
    expect(stdout()).toContain("Wrote 6 bytes");
  });

  it("get piped writes raw bytes to stdout", async () => {
    const { program } = buildProgram(() => ({ text: "RAWBYTES" }));
    const origTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      await run(program, ["server", "attachment", "get", "att-1"]);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origTty, configurable: true });
    }
    expect(process.exitCode ?? 0).toBe(0);
    const written = writeSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(
      written.some((c: unknown) => Buffer.isBuffer(c) && c.toString("binary") === "RAWBYTES"),
    ).toBe(true);
  });

  it("get -o to a bogus path → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, [
      "server",
      "attachment",
      "get",
      "att-1",
      "-o",
      path.join(workDir, "nope", "x.bin"),
    ]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("server rbac: extra branches", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("roles list: garbage body → invalid-response error, exit 1 (fail closed)", async () => {
    const { program } = buildProgram(() => ({ body: "not-an-object" }));
    await run(program, ["server", "roles", "list"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Invalid response from Ditto Server");
  });

  it("roles create --permissions @file", async () => {
    const file = path.join(workDir, "perms.json");
    fs.writeFileSync(file, JSON.stringify({ cars: { read: true, write: ["_id == 'c1'"] } }));
    const { program, calls } = buildProgram();
    await run(program, ["server", "roles", "create", "ops", "--permissions", `@${file}`]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(
      (calls[0]!.body as { doc: { collection_permissions: unknown } }).doc.collection_permissions,
    ).toEqual({
      cars: { read: true, write: ["_id == 'c1'"] },
    });
  });

  it("roles create with no permissions sends explicit defaults (POST replaces)", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "roles", "create", "empty"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.body).toEqual({
      name: "empty",
      doc: {
        roles_version: "v1-preview",
        description: "",
        collection_permissions: "none",
        grant_remote_query: false,
      },
    });
  });

  it("roles create: server 403 → exit 3", async () => {
    const { program } = buildProgram(() => ({ status: 403, body: { message: "admin required" } }));
    await run(program, ["server", "roles", "create", "staff"]);
    expect(process.exitCode).toBe(3);
  });

  it("users list: bad --limit → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "users", "list", "--limit", "nope"]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("users list: --user-id filter is sent", async () => {
    const { program, calls } = buildProgram(() => ({ body: { users: [], hasMore: false } }));
    await run(program, ["server", "users", "list", "--user-id", "auth0|9"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.url).toContain("userId=auth0%7C9");
  });

  it("users delete without -y, non-interactive → exit 2, no request", async () => {
    const { program, calls } = buildProgram();
    const origIn = process.stdin.isTTY;
    const origErr = process.stderr.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      await run(program, ["server", "users", "delete", "auth0|1"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIn, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: origErr, configurable: true });
    }
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("server doctor via the CLI", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("all checks green → exit 0", async () => {
    const { program } = buildProgram(() => ({
      body: { transactionId: 5, queryType: "select", items: [] },
    }));
    await run(program, ["server", "doctor"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout()).toContain("✓ config");
    expect(stdout()).toContain("✓ connection");
    expect(stdout()).toContain("✓ auth");
  });

  it("401 → exit 3 with guidance", async () => {
    const { program } = buildProgram(() => ({ status: 401, body: { message: "nope" } }));
    await run(program, ["server", "doctor"]);
    expect(process.exitCode).toBe(3);
    expect(stdout()).toContain("✗ auth");
  });

  it("missing config → exit 3, probe checks skipped", async () => {
    for (const k of SERVER_ENV_VARS) delete process.env[k];
    const { program } = buildProgram();
    await run(program, ["server", "doctor"]);
    expect(process.exitCode).toBe(3);
    expect(stdout()).toContain("✗ config");
    expect(stdout()).toContain("skipped");
  });

  it("honors --api-version v4 in the probe URL", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { transactionId: 5, queryType: "select", items: [] },
    }));
    await run(program, ["server", "doctor", "--api-version", "v4"]);
    expect(calls[0]!.url).toContain("/api/v4/store/execute");
  });
});

describe("server: flags reach the wire on every command family", () => {
  it("roles list with --url/--api-key flags", async () => {
    const { program, calls } = buildProgram(() => ({ body: { roles: [] } }));
    await run(program, [
      "server",
      "roles",
      "list",
      "--url",
      "flags.example/app",
      "--api-key",
      "flag-key",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.url).toBe("https://flags.example/app/api/v4/auth/roles");
  });

  it("remote-execute binds -p and --args together", async () => {
    Object.assign(process.env, ENV);
    const { program, calls } = buildProgram(() => ({ body: { result: [] } }));
    await run(program, [
      "server",
      "remote-execute",
      "SYNC CONTEXT ( PEERS WHERE peerKeyString = :pk ) SELECT * FROM c WHERE x = :x",
      "-p",
      "x=1",
      "--args",
      '{"pk":"abc"}',
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.body).toMatchObject({ args: { pk: "abc", x: 1 } });
  });

  it("users list sends --limit and --cursor", async () => {
    Object.assign(process.env, ENV);
    const { program, calls } = buildProgram(() => ({ body: { users: [], hasMore: false } }));
    await run(program, ["server", "users", "list", "--limit", "10", "--cursor", "abc"]);
    expect(calls[0]!.url).toContain("limit=10");
    expect(calls[0]!.url).toContain("cursor=abc");
  });

  it("webhook-secrets list with --format json prints rows", async () => {
    Object.assign(process.env, ENV);
    const { program } = buildProgram(() => ({
      body: { secret: [{ secret: "s1", notBefore: "a", notAfter: "b", rotated: "r" }] },
    }));
    await run(program, [
      "server",
      "webhook-secrets",
      "list",
      "--provider",
      "p1",
      "--format",
      "json",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout())).toEqual([
      { secret: "s1", notBefore: "a", notAfter: "b", rotated: "r" },
    ]);
  });
});

describe("server: interactive confirm path (mocked @inquirer/prompts)", () => {
  it("roles delete without -y prompts on a TTY and proceeds when confirmed", async () => {
    Object.assign(process.env, ENV);
    vi.doMock("@inquirer/prompts", () => ({ confirm: vi.fn(async () => true) }));
    vi.resetModules();
    const { registerServerGroup: registerFresh } = await import(
      "../../src/cli/groups/server/index.js"
    );
    const calls: { url: string; method: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method });
      return {
        status: 200,
        statusText: "",
        headers: { get: () => null },
        text: async () => "{}",
      };
    };
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerFresh(program.command("server"), { fetchImpl });

    const origIn = process.stdin.isTTY;
    const origErr = process.stderr.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    try {
      await run(program, ["server", "roles", "delete", "staff"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIn, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: origErr, configurable: true });
      vi.doUnmock("@inquirer/prompts");
      vi.resetModules();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("server webhook-secrets: extra branches", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("create without --not-after → exit 2", async () => {
    const { program, calls } = buildProgram();
    try {
      await run(program, ["server", "webhook-secrets", "create", "--provider", "p1"]);
    } catch {
      // commander requiredOption throws through exitOverride — either path is exit 2
    }
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("delete without -y, non-interactive → exit 2 after the lookup, no DELETE", async () => {
    // The confirm gate now runs AFTER connect + lookup — the secret must exist
    // for the gate to be reached; only the GET may hit the wire.
    const { program, calls } = buildProgram(() => ({
      body: { secret: [{ secret: "s1", notBefore: "a", notAfter: "b" }] },
    }));
    const origIn = process.stdin.isTTY;
    const origErr = process.stderr.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      await run(program, [
        "server",
        "webhook-secrets",
        "delete",
        "--provider",
        "p1",
        "--secret",
        "s1",
      ]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIn, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: origErr, configurable: true });
    }
    expect(process.exitCode).toBe(2);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("delete: --secret that doesn't exist → exit 1", async () => {
    const { program } = buildProgram(() => ({ body: { secret: [] } }));
    await run(program, [
      "server",
      "webhook-secrets",
      "delete",
      "--provider",
      "p1",
      "--secret",
      "nope",
      "-y",
    ]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("No webhook secret matching");
  });
});

describe("normalizeRoles shape handling (direct)", () => {
  it("handles non-objects, empty buckets, and missing fields", async () => {
    const { normalizeRoles } = await import("../../src/cli/groups/server/rbac.js");
    expect(normalizeRoles(undefined)).toEqual([]);
    expect(normalizeRoles(null)).toEqual([]);
    expect(normalizeRoles("nope")).toEqual([]);
    expect(normalizeRoles({ roles: {} })).toEqual([]);
    // bucket with an empty version array is dropped; missing fields default
    expect(
      normalizeRoles({
        roles: { gone: [], bare: [{ _id: { name: "bare", version: "v1" } }] },
      }),
    ).toEqual([
      {
        name: "bare",
        version: "v1",
        description: "",
        collection_permissions: "none",
        grant_remote_query: false,
      },
    ]);
    // paged entries with a malformed doc don't crash the row build
    expect(normalizeRoles({ roles: [null, undefined] })).toEqual([
      {
        name: undefined,
        version: undefined,
        description: "",
        collection_permissions: "none",
        grant_remote_query: false,
      },
      {
        name: undefined,
        version: undefined,
        description: "",
        collection_permissions: "none",
        grant_remote_query: false,
      },
    ]);
  });
});

describe("regression: adversarial review", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("batch: a 401 mid-batch is exit 3 (not flattened to 1) and stops the batch", async () => {
    const file = path.join(workDir, "auth.sql");
    fs.writeFileSync(file, "SELECT 1;\nSELECT 2;\nSELECT 3;\n");
    let n = 0;
    const { program, calls } = buildProgram(() => {
      n++;
      if (n === 1) return { body: { queryType: "select", items: [], mutatedDocumentIds: [] } };
      return { status: 401, body: { message: "expired key" } };
    });
    await run(program, ["server", "execute", "-f", file, "--continue-on-error"]);
    expect(process.exitCode).toBe(3);
    expect(stderr()).toContain("expired key");
    expect(calls.length).toBe(2); // stopped — auth won't heal mid-batch
    expect(stderr()).toContain("1 ok, 1 failed (of 3)");
  });

  it("batch: a 500 stays exit 1 and honors stop-on-first-error", async () => {
    const file = path.join(workDir, "boom.sql");
    fs.writeFileSync(file, "SELECT 1;\nSELECT 2;\nSELECT 3;\n");
    const { program, calls } = buildProgram(() => ({ status: 500, body: { message: "boom" } }));
    await run(program, ["server", "execute", "-f", file]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("single-statement -f prints no batch summary", async () => {
    const file = path.join(workDir, "one.sql");
    fs.writeFileSync(file, "SELECT 1;\n");
    const { program } = buildProgram(() => ({
      body: { queryType: "select", items: [{ a: 1 }], mutatedDocumentIds: [] },
    }));
    await run(program, ["server", "execute", "-f", file]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr()).not.toContain("ok,");
    expect(stderr()).not.toContain("failed");
  });

  it("remote-execute --args - on a TTY → exit 2 (no hang)", async () => {
    const { program, calls } = buildProgram();
    await withStdinTTY(true, async () => {
      await run(program, [
        "server",
        "remote-execute",
        "SYNC CONTEXT ( PEERS WHERE peerKeyString = 'x' ) SELECT 1",
        "--args",
        "-",
      ]);
    })();
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("stdin is a terminal");
    expect(calls).toHaveLength(0);
  });

  it("-f single-mutation + -o → exit 2 (same rule as the positional form)", async () => {
    const file = path.join(workDir, "mut.sql");
    fs.writeFileSync(file, "DELETE FROM cars WHERE year < 1990;\n");
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "-f", file, "-o", path.join(workDir, "x.json")]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("row-producing");
    expect(calls).toHaveLength(0);
  });

  it("roles list --format yaml → exit 2 BEFORE any request", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "roles", "list", "--format", "yaml"]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("users list --max-rows abc → exit 2 BEFORE any request", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "users", "list", "--max-rows", "abc"]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("webhook-secrets list --format yaml → exit 2 BEFORE any request", async () => {
    const { program, calls } = buildProgram();
    await run(program, [
      "server",
      "webhook-secrets",
      "list",
      "--provider",
      "p",
      "--format",
      "yaml",
    ]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("roles list surfaces the paged shape's cursor", async () => {
    const { program } = buildProgram(() => ({
      body: {
        roles: [{ _id: { name: "staff", version: "v1" } }],
        hasMore: true,
        cursor: "page-2",
      },
    }));
    await run(program, ["server", "roles", "list"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr()).toContain("--cursor page-2");
  });

  it("roles list --cursor is sent", async () => {
    const { program, calls } = buildProgram(() => ({ body: { roles: [], hasMore: false } }));
    await run(program, ["server", "roles", "list", "--cursor", "page-2"]);
    expect(calls[0]!.url).toContain("cursor=page-2");
  });

  it("--api-key value starting with '=' is not corrupted", async () => {
    const { program, calls } = buildProgram(() => ({
      body: { queryType: "select", items: [], mutatedDocumentIds: [] },
    }));
    await run(program, [
      "server",
      "execute",
      "SELECT 1",
      "--url",
      "mock.example/app",
      "--api-key",
      "=abc",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]!.url).toContain("mock.example");
    expect(calls[0]!.authorization).toBe("Bearer =abc");
  });

  it("doctor --api-version v9 → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "doctor", "--api-version", "v9"]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("regression: round-3 agreed minors", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("roles create --permissions with a non-blanket JSON string → exit 2 (no request)", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "roles", "create", "staff", "--permissions", '"not-a-blanket"']);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--permissions must be");
    expect(calls).toHaveLength(0);
  });

  it("roles create --permissions accepts a quoted blanket string", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "roles", "create", "staff", "--permissions", '"read_only"']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(
      (calls[0]!.body as { doc: { collection_permissions: string } }).doc.collection_permissions,
    ).toBe("read_only");
  });

  it("execute --timeout abc → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, ["server", "execute", "SELECT 1", "--timeout", "abc"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--timeout must be an integer");
    expect(calls).toHaveLength(0);
  });

  it("remote-execute accepts SYNC CONTEXT behind a leading comment (after --)", async () => {
    const { program, calls } = buildProgram(() => ({ body: { result: [] } }));
    // A statement starting with "--" needs the -- separator so commander
    // doesn't read it as an option (same rule as the dql group).
    await run(program, [
      "server",
      "remote-execute",
      "--",
      "-- probe\nSYNC CONTEXT ( PEERS WHERE peerKeyString = 'x' ) SELECT 1",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("remote-execute --timeout abc → exit 2", async () => {
    const { program, calls } = buildProgram();
    await run(program, [
      "server",
      "remote-execute",
      "SYNC CONTEXT ( PEERS WHERE peerKeyString = 'x' ) SELECT 1",
      "--timeout",
      "abc",
    ]);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("users list 404 → exit 1 with an unsupported-endpoint hint", async () => {
    const { program } = buildProgram(() => ({ status: 404, body: { message: "Not Found" } }));
    await run(program, ["server", "users", "list"]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("may not support the users endpoint");
  });
});
