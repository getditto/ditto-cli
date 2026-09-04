import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

/**
 * e2e for `dittosh server` against a local mock Ditto Server (node:http).
 * The spawned CLI is the real entrypoint; only the network is fake.
 *
 * Env hygiene: tests/setup/env.ts loads the repo .env (which may contain REAL
 * portal credentials) into this process, and execa inherits by default. Every
 * spawn below therefore passes an explicit env — either overriding
 * DITTOSH_SERVER_* at the mock, or extending nothing (missing-config tests
 * also run from an empty tmp cwd so no .env is found).
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs");

interface CapturedRequest {
  method: string;
  url: string;
  authorization?: string;
  txnId?: string;
  body: string;
}

let server: http.Server;
let port: number;
let requests: CapturedRequest[];
/** Per-test response override; default: empty successful execute response. */
let responder: (req: CapturedRequest, res: http.ServerResponse) => void;

function defaultResponder(req: CapturedRequest, res: http.ServerResponse) {
  if (req.url.includes("/store/execute")) {
    const statement = (JSON.parse(req.body) as { statement: string }).statement;
    if (statement.startsWith("BROKEN")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          queryType: "unknown",
          items: [],
          mutatedDocumentIds: [],
          error: { description: "syntax error near BROKEN" },
          warnings: [],
          totalWarningsCount: 0,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        transactionId: 42,
        queryType: "select",
        items: [{ _id: "c1", name: "Ada" }],
        mutatedDocumentIds: [],
        warnings: [],
        totalWarningsCount: 0,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({}));
}

beforeAll(async () => {
  requests = [];
  responder = defaultResponder;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        txnId: req.headers["x-ditto-txn-id"] as string | undefined,
        body,
      };
      requests.push(captured);
      responder(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function cli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; input?: string; extend?: boolean } = {},
) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NO_COLOR: "1",
    DITTOSH_NO_UPDATE_CHECK: "1",
    ...(opts.extend === false
      ? {}
      : {
          DITTOSH_SERVER_URL: `http://127.0.0.1:${port}/app-id`,
          DITTOSH_SERVER_API_KEY: "e2e-key",
        }),
    ...opts.env,
  };
  // Default cwd is a fresh tmpdir, NOT the repo root — the repo .env may hold
  // real portal credentials and the spawned process would read them via the
  // cwd-.env fallback (env vars set below always win over it anyway).
  return execa(process.execPath, ["--import", TSX, path.join(ROOT, "src/cli/index.ts"), ...args], {
    cwd: opts.cwd ?? tmpDataDir("dittosh-e2e-cwd-"),
    reject: false,
    env,
    extendEnv: false,
    input: opts.input,
  }) as unknown as Promise<RunResult>;
}

describe("e2e: dittosh server execute", () => {
  it("runs a SELECT against the mock server — JSON on stdout, auth header sent", async () => {
    const r = await cli(["server", "execute", "SELECT * FROM customers LIMIT 1"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ _id: "c1", name: "Ada" }]);
    const req = requests.at(-1)!;
    expect(req.url).toBe("/app-id/api/v5/store/execute");
    expect(req.authorization).toBe("Bearer e2e-key");
    expect(JSON.parse(req.body)).toEqual({ statement: "SELECT * FROM customers LIMIT 1" });
  });

  it("sends X-DITTO-TXN-ID when --txn-id is passed", async () => {
    const r = await cli(["server", "execute", "SELECT 1", "--txn-id", "17"]);
    expect(r.exitCode).toBe(0);
    expect(requests.at(-1)!.txnId).toBe("17");
  });

  it("uses v4 when --api-version v4", async () => {
    const r = await cli(["server", "execute", "SELECT 1", "--api-version", "v4"]);
    expect(r.exitCode).toBe(0);
    expect(requests.at(-1)!.url).toContain("/api/v4/store/execute");
  });

  it("DQL error from the server → exit 1, error on stderr, stdout clean", async () => {
    const r = await cli(["server", "execute", "BROKEN"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("syntax error near BROKEN");
    expect(r.stdout).toBe("");
  });

  it("HTTP 401 → exit 3", async () => {
    const prev = responder;
    responder = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "invalid API key" }));
    };
    try {
      const r = await cli(["server", "execute", "SELECT 1"]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("invalid API key");
      expect(r.stdout).toBe("");
    } finally {
      responder = prev;
    }
  });

  it("unreachable server → exit 3 with a connection error", async () => {
    const r = await cli(["server", "execute", "SELECT 1"], {
      env: { DITTOSH_SERVER_URL: "http://127.0.0.1:1/app", DITTOSH_SERVER_API_KEY: "k" },
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("Cannot reach");
  });

  it("piped stdin batch runs one call per statement", async () => {
    const before = requests.length;
    const r = await cli(["server", "execute"], { input: "SELECT 1;\nSELECT 2;\n" });
    expect(r.exitCode).toBe(0);
    expect(requests.length - before).toBe(2);
    expect(r.stderr).toContain("2 ok, 0 failed (of 2)");
  });

  it("usage error: statement + -e together → exit 2, no request", async () => {
    const before = requests.length;
    const r = await cli(["server", "execute", "SELECT 1", "-e", "SELECT 2"]);
    expect(r.exitCode).toBe(2);
    expect(requests.length).toBe(before);
  });
});

describe("e2e: dittosh server config resolution", () => {
  it("missing URL/key → exit 3 with guidance (empty cwd, scrubbed env)", async () => {
    const cwd = tmpDataDir("dittosh-e2e-nocfg-");
    try {
      const r = await cli(["server", "execute", "SELECT 1"], { cwd, extend: false });
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("DITTOSH_SERVER_URL");
      expect(r.stderr).toContain("--url");
    } finally {
      rmrf(cwd);
    }
  });

  it(".env in the cwd provides config", async () => {
    const fs = await import("node:fs");
    const cwd = tmpDataDir("dittosh-e2e-dotenv-");
    try {
      fs.writeFileSync(
        path.join(cwd, ".env"),
        `DITTOSH_SERVER_URL=http://127.0.0.1:${port}/from-dotenv\nDITTOSH_SERVER_API_KEY=dotenv-key\n`,
      );
      const r = await cli(["server", "execute", "SELECT 1"], { cwd, extend: false });
      expect(r.exitCode).toBe(0);
      const req = requests.at(-1)!;
      expect(req.url).toBe("/from-dotenv/api/v5/store/execute");
      expect(req.authorization).toBe("Bearer dotenv-key");
    } finally {
      rmrf(cwd);
    }
  });

  it("--url/--api-key flags beat everything", async () => {
    const r = await cli(
      [
        "server",
        "execute",
        "SELECT 1",
        "--url",
        `http://127.0.0.1:${port}/flag-app`,
        "--api-key",
        "flag-key",
      ],
      { extend: false },
    );
    expect(r.exitCode).toBe(0);
    expect(requests.at(-1)!.url).toBe("/flag-app/api/v5/store/execute");
    expect(requests.at(-1)!.authorization).toBe("Bearer flag-key");
  });

  it("bad URL → exit 3 with a clear message", async () => {
    const r = await cli(
      ["server", "execute", "SELECT 1", "--url", "ht tp://bad", "--api-key", "k"],
      {
        extend: false,
      },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("Invalid server URL");
  });
});

describe("e2e: dittosh server help documents itself", () => {
  it("group help lists commands and the config story", async () => {
    const r = await cli(["server", "--help"], { extend: false });
    expect(r.exitCode).toBe(0);
    for (const needle of [
      "execute",
      "remote-execute",
      "attachment",
      "roles",
      "users",
      "webhook-secrets",
      "doctor",
      "DITTOSH_SERVER_URL",
      "DITTOSH_SERVER_API_KEY",
    ]) {
      expect(r.stdout).toContain(needle);
    }
  });

  it("execute --help documents the request body and examples", async () => {
    const r = await cli(["server", "execute", "--help"], { extend: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("store/execute");
    expect(r.stdout).toContain("statement");
    expect(r.stdout).toContain("args");
    expect(r.stdout).toContain("--api-version");
  });

  it("roles create --help documents the permissions shape", async () => {
    const r = await cli(["server", "roles", "create", "--help"], { extend: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("collection_permissions");
    expect(r.stdout).toContain("read_only");
  });

  it("remote-execute without SYNC CONTEXT → exit 2 with guidance", async () => {
    const r = await cli(["server", "remote-execute", "SELECT 1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("SYNC CONTEXT");
  });
});

describe("e2e: dittosh server admin commands against the mock", () => {
  it("roles list renders rows", async () => {
    const prev = responder;
    responder = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          roles: {
            staff: [
              {
                _id: { name: "staff", version: "v1" },
                roles_version: "v1-preview",
                description: "Store staff",
                collection_permissions: "read_only",
                grant_remote_query: false,
              },
            ],
          },
        }),
      );
    };
    try {
      const r = await cli(["server", "roles", "list"]);
      expect(r.exitCode).toBe(0);
      const rows = JSON.parse(r.stdout);
      expect(rows).toEqual([
        {
          name: "staff",
          version: "v1",
          description: "Store staff",
          collection_permissions: "read_only",
          grant_remote_query: false,
        },
      ]);
    } finally {
      responder = prev;
    }
  });

  it("attachment get refuses binary on a TTY… (piped here) writes bytes to stdout", async () => {
    const prev = responder;
    responder = (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    };
    try {
      const r = await execa(
        process.execPath,
        [
          "--import",
          TSX,
          path.join(ROOT, "src/cli/index.ts"),
          "server",
          "attachment",
          "get",
          "att-1",
        ],
        {
          cwd: ROOT,
          reject: false,
          encoding: "buffer",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            NO_COLOR: "1",
            DITTOSH_NO_UPDATE_CHECK: "1",
            DITTOSH_SERVER_URL: `http://127.0.0.1:${port}/app-id`,
            DITTOSH_SERVER_API_KEY: "e2e-key",
          },
          extendEnv: false,
        },
      );
      expect(r.exitCode).toBe(0);
      expect(Buffer.from(r.stdout as unknown as Uint8Array).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    } finally {
      responder = prev;
    }
  });
});

describe("e2e: dittosh server doctor", () => {
  it("all checks green against the mock", async () => {
    const r = await cli(["server", "doctor"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ config");
    expect(r.stdout).toContain("✓ connection");
    expect(r.stdout).toContain("✓ auth");
    expect(requests.at(-1)!.url).toBe("/app-id/api/v5/store/execute");
    expect(JSON.parse(requests.at(-1)!.body)).toEqual({
      statement: "SELECT * FROM system:collections LIMIT 1",
    });
  });

  it("401 → exit 3, auth fails", async () => {
    const prev = responder;
    responder = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "unauthorized" }));
    };
    try {
      const r = await cli(["server", "doctor"]);
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toContain("✗ auth");
    } finally {
      responder = prev;
    }
  });
});

describe("e2e: dittosh server RBAC + webhook writes against the mock", () => {
  it("roles create → delete round trip", async () => {
    const prev = responder;
    responder = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    };
    try {
      const c = await cli([
        "server",
        "roles",
        "create",
        "staff",
        "--description",
        "Store staff",
        "--permissions",
        "read_only",
      ]);
      expect(c.exitCode).toBe(0);
      const createReq = requests.at(-1)!;
      expect(createReq.method).toBe("POST");
      expect(JSON.parse(createReq.body)).toEqual({
        name: "staff",
        doc: {
          roles_version: "v1-preview",
          description: "Store staff",
          collection_permissions: "read_only",
          grant_remote_query: false,
        },
      });

      const d = await cli(["server", "roles", "delete", "staff", "-y"]);
      expect(d.exitCode).toBe(0);
      expect(requests.at(-1)!.method).toBe("DELETE");
      expect(requests.at(-1)!.url).toBe("/app-id/api/v4/auth/roles/staff");
    } finally {
      responder = prev;
    }
  });

  it("users list / set-roles / delete", async () => {
    const prev = responder;
    responder = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.includes("/auth/users") && req.method === "GET") {
        res.end(
          JSON.stringify({
            users: [{ userId: "auth0|1", roles: ["staff"], identityVersion: "v1" }],
            hasMore: false,
          }),
        );
      } else if (req.method === "PATCH") {
        res.end(JSON.stringify({ identityVersion: "v2", transactionId: 12 }));
      } else {
        res.end(JSON.stringify({}));
      }
    };
    try {
      const l = await cli(["server", "users", "list"]);
      expect(l.exitCode).toBe(0);
      expect(JSON.parse(l.stdout)).toEqual([
        { userId: "auth0|1", roles: ["staff"], identityVersion: "v1" },
      ]);

      const s = await cli(["server", "users", "set-roles", "auth0|1", "staff", "ops"]);
      expect(s.exitCode).toBe(0);
      expect(JSON.parse(requests.at(-1)!.body)).toEqual({ roles: ["staff", "ops"] });
      expect(JSON.parse(s.stdout).transactionId).toBe(12);

      const d = await cli(["server", "users", "delete", "auth0|1", "-y"]);
      expect(d.exitCode).toBe(0);
      expect(requests.at(-1)!.method).toBe("DELETE");
    } finally {
      responder = prev;
    }
  });

  it("webhook-secrets list → create → rotate → delete against the mock", async () => {
    const existing = { secret: "s1", notBefore: "a", notAfter: "b" };
    const prev = responder;
    responder = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET") {
        res.end(JSON.stringify({ secret: [existing] }));
      } else if (req.method === "POST") {
        res.end(JSON.stringify({ secret: "created-secret", notBefore: "x", notAfter: "y" }));
      } else if (req.method === "PATCH") {
        res.end(JSON.stringify({ secret: "rotated-secret", notBefore: "x", notAfter: "z" }));
      } else {
        res.end(JSON.stringify({}));
      }
    };
    try {
      const l = await cli(["server", "webhook-secrets", "list", "--provider", "p1"]);
      expect(l.exitCode).toBe(0);
      expect(JSON.parse(l.stdout)[0].secret).toBe("s1");

      const c = await cli([
        "server",
        "webhook-secrets",
        "create",
        "--provider",
        "p1",
        "--not-after",
        "2027-01-01T00:00:00Z",
      ]);
      expect(c.exitCode).toBe(0);
      expect(JSON.parse(c.stdout).secret).toBe("created-secret");

      const ro = await cli([
        "server",
        "webhook-secrets",
        "rotate",
        "--provider",
        "p1",
        "--secret",
        "s1",
        "--not-after",
        "2027-06-01T00:00:00Z",
      ]);
      expect(ro.exitCode).toBe(0);
      expect(JSON.parse(ro.stdout).secret).toBe("rotated-secret");
      const patch = requests.at(-1)!;
      expect(JSON.parse(patch.body).rotate).toEqual(existing);

      const d = await cli([
        "server",
        "webhook-secrets",
        "delete",
        "--provider",
        "p1",
        "--secret",
        "s1",
        "-y",
      ]);
      expect(d.exitCode).toBe(0);
      const del = requests.at(-1)!;
      expect(del.method).toBe("DELETE");
      expect(JSON.parse(del.body)).toEqual({ provider: "p1", ...existing });
    } finally {
      responder = prev;
    }
  });

  it("attachment upload posts multipart and prints {id, len}", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-e2e-att-"));
    const file = path.join(dir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const prev = responder;
    responder = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "att-9", len: 4 }));
    };
    try {
      const r = await cli(["server", "attachment", "upload", file]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ id: "att-9", len: 4 });
      expect(requests.at(-1)!.url).toBe("/app-id/api/v4/attachments/upload");
    } finally {
      responder = prev;
      rmrf(dir);
    }
  });

  it("remote-execute happy path renders the per-peer envelope", async () => {
    const prev = responder;
    responder = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          result: [{ peer: { peerKeyString: "pk1" }, elapsedMilliseconds: 5, items: [{ a: 1 }] }],
        }),
      );
    };
    try {
      const r = await cli([
        "server",
        "remote-execute",
        "SYNC CONTEXT ( PEERS WHERE peerKeyString = 'pk1' ) SELECT * FROM cars LIMIT 5",
      ]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed[0].peer.peerKeyString).toBe("pk1");
      expect(parsed[0].items).toEqual([{ a: 1 }]);
      expect(requests.at(-1)!.url).toBe("/app-id/api/v5/sync/remote_execute");
    } finally {
      responder = prev;
    }
  });
});
