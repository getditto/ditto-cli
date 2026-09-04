import { describe, expect, it } from "vitest";
import {
  type FetchLike,
  PortalApiError,
  PortalClient,
  PortalConnectionError,
} from "../../src/server/client.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | FormData;
}

/** Build a fetch stub that records calls and replies with the given status/body. */
function mockFetch(
  handler: (call: CapturedCall) => { status?: number; body?: unknown; text?: string } = () => ({}),
): { fetchImpl: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: CapturedCall = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const reply = handler(call);
    const text = reply.text ?? (reply.body !== undefined ? JSON.stringify(reply.body) : "");
    return {
      status: reply.status ?? 200,
      statusText: "",
      headers: { get: () => "application/json" },
      text: async () => text,
    };
  };
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: FetchLike) {
  return new PortalClient({
    baseUrl: "https://abc.cloud.dittolive.app/app-id",
    apiKey: "sekret-key",
    fetchImpl,
  });
}

describe("PortalClient request plumbing", () => {
  it("sends the bearer token and JSON body to the right URL", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: { transactionId: 7, queryType: "select", items: [{ a: 1 }] },
    }));
    const client = makeClient(fetchImpl);
    const res = await client.execute("SELECT * FROM cars", undefined, {});
    expect(calls[0]!.url).toBe("https://abc.cloud.dittolive.app/app-id/api/v5/store/execute");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe("Bearer sekret-key");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ statement: "SELECT * FROM cars" });
    expect(res.transactionId).toBe(7);
    expect(res.items).toEqual([{ a: 1 }]);
  });

  it("includes args only when provided", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = makeClient(fetchImpl);
    await client.execute("SELECT * FROM cars WHERE color = :c", { c: "blue" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      statement: "SELECT * FROM cars WHERE color = :c",
      args: { c: "blue" },
    });
  });

  it("honors the v4 API version", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = makeClient(fetchImpl);
    await client.execute("SELECT 1", undefined, { version: "v4" });
    expect(calls[0]!.url).toContain("/api/v4/store/execute");
  });

  it("sets X-DITTO-TXN-ID when asked", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = makeClient(fetchImpl);
    await client.execute("SELECT 1", undefined, { txnId: 17 });
    expect(calls[0]!.headers["X-DITTO-TXN-ID"]).toBe("17");
  });

  it("maps 400 to PortalApiError with exit 1 and the server's message", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 400,
      body: { message: "Invalid query" },
    }));
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELEC broken").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalApiError);
    expect((err as PortalApiError).status).toBe(400);
    expect((err as PortalApiError).exitCode).toBe(1);
    expect((err as PortalApiError).message).toContain("Invalid query");
  });

  it("reads error.description when message is absent (execute error shape)", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 400,
      body: { error: { description: "syntax error near SELEC" } },
    }));
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELEC").catch((e: unknown) => e);
    expect((err as PortalApiError).message).toContain("syntax error near SELEC");
  });

  it("maps 401/403 to exit 3 (auth)", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = mockFetch(() => ({ status, body: { message: "denied" } }));
      const client = makeClient(fetchImpl);
      const err = await client.execute("SELECT 1").catch((e: unknown) => e);
      expect((err as PortalApiError).exitCode).toBe(3);
    }
  });

  it("handles plain-text error bodies", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 502, text: "Bad Gateway" }));
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELECT 1").catch((e: unknown) => e);
    expect((err as PortalApiError).message).toContain("HTTP 502");
    expect((err as PortalApiError).message).toContain("Bad Gateway");
  });

  it("throws PortalConnectionError (exit 3) when the network fails", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND nope.invalid");
    };
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELECT 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalConnectionError);
    expect((err as PortalConnectionError).exitCode).toBe(3);
    expect((err as PortalConnectionError).message).toContain("Cannot reach");
  });

  it("redacts the API key if it ever appears in an error message", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("auth failed for sekret-key");
    };
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELECT 1").catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("sekret-key");
    expect((err as Error).message).toContain("***");
  });
});

describe("PortalClient endpoints", () => {
  it("remoteExecute posts to /api/v5/sync/remote_execute", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { result: [] } }));
    const client = makeClient(fetchImpl);
    await client.remoteExecute("SYNC CONTEXT ( PEERS WHERE peerKeyString = 'x' ) SELECT 1", {
      a: 1,
    });
    expect(calls[0]!.url).toContain("/api/v5/sync/remote_execute");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      statement: "SYNC CONTEXT ( PEERS WHERE peerKeyString = 'x' ) SELECT 1",
      args: { a: 1 },
    });
  });

  it("uploadAttachment posts multipart form data without a JSON content-type", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { id: "att-1", len: 3 } }));
    const client = makeClient(fetchImpl);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "x.bin");
    const res = await client.uploadAttachment(form);
    expect(calls[0]!.url).toContain("/api/v4/attachments/upload");
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    expect(res.id).toBe("att-1");
  });

  it("getAttachment GETs /api/v4/attachments/{id} and returns bytes", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ text: "PNGDATA" }));
    const client = makeClient(fetchImpl);
    const bytes = await client.getAttachment("att 1"); // space exercises encoding
    expect(calls[0]!.url).toContain("/api/v4/attachments/att%201");
    expect(calls[0]!.method).toBe("GET");
    expect(bytes.toString("binary")).toBe("PNGDATA");
  });

  it("getAttachment maps HTTP errors", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: { message: "no attachment" } }));
    const client = makeClient(fetchImpl);
    const err = await client.getAttachment("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalApiError);
    expect((err as PortalApiError).message).toContain("no attachment");
  });

  it("getAttachment surfaces connection failures", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = makeClient(fetchImpl);
    const err = await client.getAttachment("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalConnectionError);
  });
});

describe("PortalClient RBAC", () => {
  it("listRoles GETs /api/v4/auth/roles", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { roles: {} } }));
    const client = makeClient(fetchImpl);
    await client.listRoles();
    expect(calls[0]!.url).toContain("/api/v4/auth/roles");
    expect(calls[0]!.method).toBe("GET");
  });

  it("createRole posts the v1-preview doc envelope", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = makeClient(fetchImpl);
    await client.createRole({
      name: "staff",
      description: "Store staff",
      collectionPermissions: "read_only",
      grantRemoteQuery: true,
    });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      name: "staff",
      doc: {
        roles_version: "v1-preview",
        description: "Store staff",
        collection_permissions: "read_only",
        grant_remote_query: true,
      },
    });
  });

  it("createRole sends explicit defaults for unset fields (portal parity: POST replaces)", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = makeClient(fetchImpl);
    await client.createRole({ name: "staff" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      name: "staff",
      doc: {
        roles_version: "v1-preview",
        description: "",
        collection_permissions: "none",
        grant_remote_query: false,
      },
    });
  });

  it("deleteRole DELETEs the named role, URL-encoded", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = makeClient(fetchImpl);
    await client.deleteRole("ops/team lead");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/api/v4/auth/roles/ops%2Fteam%20lead");
  });

  it("listUsers passes query params", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: { users: [], hasMore: true, cursor: "c2" },
    }));
    const client = makeClient(fetchImpl);
    const res = await client.listUsers({ userId: "auth0|1", cursor: "c1", limit: 25 });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("userId")).toBe("auth0|1");
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(res.hasMore).toBe(true);
  });

  it("listUsers omits empty params", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { users: [], hasMore: false } }));
    const client = makeClient(fetchImpl);
    await client.listUsers();
    expect(calls[0]!.url).not.toContain("?");
  });

  it("setUserRoles PATCHes the roles array", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: { identityVersion: "v9", transactionId: 12 },
    }));
    const client = makeClient(fetchImpl);
    await client.setUserRoles("auth0|1234", ["staff", "ops"]);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/api/v4/auth/users/auth0%7C1234");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ roles: ["staff", "ops"] });
  });

  it("deleteUser DELETEs the user", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = makeClient(fetchImpl);
    await client.deleteUser("oidc|team lead#1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/api/v4/auth/users/oidc%7Cteam%20lead%231");
  });
});

describe("PortalClient webhook secrets", () => {
  it("list normalizes {} to []", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: {} }));
    expect(await makeClient(fetchImpl).listWebhookSecrets("p")).toEqual([]);
  });

  it("list normalizes {secret: [...]}", async () => {
    const secret = { secret: "s1", notBefore: "a", notAfter: "b" };
    const { fetchImpl } = mockFetch(() => ({ body: { secret: [secret] } }));
    expect(await makeClient(fetchImpl).listWebhookSecrets("p")).toEqual([secret]);
  });

  it("list normalizes a bare array", async () => {
    const secret = { secret: "s1", notBefore: "a", notAfter: "b" };
    const { fetchImpl } = mockFetch(() => ({ body: [secret] }));
    expect(await makeClient(fetchImpl).listWebhookSecrets("p")).toEqual([secret]);
  });

  it("list normalizes a single secret object", async () => {
    const secret = { secret: "s1", notBefore: "a", notAfter: "b" };
    const { fetchImpl } = mockFetch(() => ({ body: secret }));
    expect(await makeClient(fetchImpl).listWebhookSecrets("p")).toEqual([secret]);
  });

  it("list returns [] for garbage", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { unexpected: 1 } }));
    expect(await makeClient(fetchImpl).listWebhookSecrets("p")).toEqual([]);
  });

  it("create posts provider + validity window", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: { secret: "s", notBefore: "nb", notAfter: "2027-01-01T00:00:00Z" },
    }));
    await makeClient(fetchImpl).createWebhookSecret("prov", "2027-01-01T00:00:00Z");
    const body = JSON.parse(calls[0]!.body as string);
    expect(body.provider).toBe("prov");
    expect(body.notAfter).toBe("2027-01-01T00:00:00Z");
    expect(typeof body.notBefore).toBe("string");
  });

  it("rotate patches with rotate + new windows", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      body: { secret: "new", notBefore: "x", notAfter: "y" },
    }));
    const existing = { secret: "old", notBefore: "a", notAfter: "b" };
    await makeClient(fetchImpl).rotateWebhookSecret("prov", existing, "2027-06-01T00:00:00Z");
    expect(calls[0]!.method).toBe("PATCH");
    const body = JSON.parse(calls[0]!.body as string);
    expect(body.provider).toBe("prov");
    expect(body.rotate).toEqual(existing);
    expect(body.new.notAfter).toBe("2027-06-01T00:00:00Z");
  });

  it("delete sends exactly the four fields the server wants (no extras like `rotated`)", async () => {
    const { fetchImpl, calls } = mockFetch();
    const existing = { provider: "prov", secret: "s", notBefore: "a", notAfter: "b", rotated: "r" };
    await makeClient(fetchImpl).deleteWebhookSecret(existing);
    expect(calls[0]!.method).toBe("DELETE");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      provider: "prov",
      secret: "s",
      notBefore: "a",
      notAfter: "b",
    });
  });
});

describe("regression: adversarial review fixes", () => {
  it("mid-body timeout (text() rejects) maps to PortalConnectionError exit 3", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      statusText: "",
      headers: { get: () => null },
      text: async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      },
    });
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELECT 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalConnectionError);
    expect((err as PortalConnectionError).exitCode).toBe(3);
    expect((err as Error).message).toContain("timed out");
  });

  it("undici's 'fetch failed' surfaces the cause reason (ENOTFOUND etc.)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND nope.invalid"),
      });
    };
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELECT 1").catch((e: unknown) => e);
    expect((err as Error).message).toContain("ENOTFOUND");
  });

  it("getAttachment body-read failure maps to PortalConnectionError", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      statusText: "",
      headers: { get: () => null },
      text: async () => "",
      arrayBuffer: async () => {
        throw new Error("socket hang up");
      },
    });
    const client = makeClient(fetchImpl);
    const err = await client.getAttachment("a1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalConnectionError);
    expect((err as Error).message).toContain("socket hang up");
  });

  it("a 200 with an error.description body fails write-ish endpoints", async () => {
    const { fetchImpl } = mockFetch(() => ({
      body: { error: { description: "quota exceeded" } },
    }));
    const client = makeClient(fetchImpl);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1])]), "x.bin");
    const err = await client.uploadAttachment(form).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalApiError);
    expect((err as PortalApiError).message).toContain("quota exceeded");
    expect((err as PortalApiError).exitCode).toBe(1);

    await expect(client.createRole({ name: "r" })).rejects.toBeInstanceOf(PortalApiError);
    await expect(client.setUserRoles("u", [])).rejects.toBeInstanceOf(PortalApiError);
    await expect(client.createWebhookSecret("p", "2027-01-01T00:00:00Z")).rejects.toBeInstanceOf(
      PortalApiError,
    );
    await expect(
      client.rotateWebhookSecret("p", { secret: "s", notBefore: "a", notAfter: "b" }, "c"),
    ).rejects.toBeInstanceOf(PortalApiError);
  });

  it("listRoles passes the cursor query param", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { roles: [], hasMore: false } }));
    await makeClient(fetchImpl).listRoles({ cursor: "abc123" });
    expect(calls[0]!.url).toContain("cursor=abc123");
  });

  it("listRoles without a cursor sends no query string", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { roles: {} } }));
    await makeClient(fetchImpl).listRoles();
    expect(calls[0]!.url).not.toContain("?");
  });
});

describe("regression: AggregateError cause (ECONNREFUSED on localhost)", () => {
  it("digs into cause.errors[0] when the cause message is empty", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed", {
        cause: new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:8080")], ""),
      });
    };
    const client = makeClient(fetchImpl);
    const err = await client.execute("SELECT 1").catch((e: unknown) => e);
    expect((err as Error).message).toContain("ECONNREFUSED");
  });

  it("list/delete endpoints fail on a 200-with-error body", async () => {
    const { fetchImpl } = mockFetch(() => ({
      body: { error: { description: "rbac backend down" } },
    }));
    const client = makeClient(fetchImpl);
    await expect(client.listRoles()).rejects.toBeInstanceOf(PortalApiError);
    await expect(client.listUsers()).rejects.toBeInstanceOf(PortalApiError);
    await expect(client.listWebhookSecrets("p")).rejects.toBeInstanceOf(PortalApiError);
    await expect(client.deleteRole("r")).rejects.toBeInstanceOf(PortalApiError);
    await expect(client.deleteUser("u")).rejects.toBeInstanceOf(PortalApiError);
    await expect(
      client.deleteWebhookSecret({ provider: "p", secret: "s", notBefore: "a", notAfter: "b" }),
    ).rejects.toBeInstanceOf(PortalApiError);
  });
});
