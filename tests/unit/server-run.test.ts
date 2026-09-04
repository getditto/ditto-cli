import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExecuteResponse,
  type FetchLike,
  PortalApiError,
  PortalClient,
  PortalConnectionError,
  type RemoteExecuteResponse,
} from "../../src/server/client.js";
import {
  normalizeItems,
  printWarnings,
  runServerExecute,
  runServerRemoteExecute,
  type ServerRunOptions,
} from "../../src/server/run.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let dir: string;

beforeEach(() => {
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = tmpDataDir("dittosh-server-run-");
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmrf(dir);
  delete process.env.DITTOSH_JSON_OUT;
});

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

/** A PortalClient whose execute/remoteExecute return canned responses (no HTTP). */
function cannedClient(handlers: {
  execute?: ExecuteResponse | (() => ExecuteResponse);
  remoteExecute?: RemoteExecuteResponse;
}): PortalClient {
  const fetchImpl: FetchLike = async (url) => {
    const isRemote = url.includes("remote_execute");
    const body = isRemote
      ? (handlers.remoteExecute ?? { result: [] })
      : typeof handlers.execute === "function"
        ? handlers.execute()
        : (handlers.execute ?? {});
    return {
      status: 200,
      statusText: "",
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(body),
    };
  };
  return new PortalClient({ baseUrl: "https://x.example/app", apiKey: "k", fetchImpl });
}

function opts(over: Partial<ServerRunOptions> = {}): ServerRunOptions {
  return {
    maxRows: 10_000,
    maxRowsExplicit: false,
    stdoutIsTTY: false,
    page: () => false, // never spawn a pager in tests
    ...over,
  };
}

describe("normalizeItems", () => {
  it("passes objects through, wraps scalars, and null-safes", () => {
    expect(normalizeItems([{ a: 1 }, 5, "s", null, undefined, [1, 2]])).toEqual([
      { a: 1 },
      { value: 5 },
      { value: "s" },
      {},
      {},
      { value: [1, 2] },
    ]);
  });
});

describe("printWarnings", () => {
  it("prints each warning and the overflow count to stderr", () => {
    printWarnings({
      warnings: [{ description: "w1" }, { description: "w2" }],
      totalWarningsCount: 5,
    });
    const err = stderr();
    expect(err).toContain("warning: w1");
    expect(err).toContain("warning: w2");
    expect(err).toContain("3 more warning(s)");
  });

  it("stays quiet with no warnings", () => {
    printWarnings({});
    printWarnings({ warnings: [] });
    expect(stderr()).toBe("");
  });
});

describe("runServerExecute", () => {
  it("renders SELECT items as JSON when piped", async () => {
    const client = cannedClient({
      execute: {
        transactionId: 42,
        queryType: "select",
        items: [{ _id: "c1", name: "Ada" }],
        mutatedDocumentIds: [],
      },
    });
    const r = await runServerExecute(client, "SELECT * FROM customers", opts());
    expect(r.ok).toBe(true);
    expect(JSON.parse(stdout())).toEqual([{ _id: "c1", name: "Ada" }]);
    expect(stderr()).toContain("transactionId 42");
  });

  it("renders a table when asked", async () => {
    const client = cannedClient({
      execute: { queryType: "select", items: [{ n: 3 }], mutatedDocumentIds: [] },
    });
    const r = await runServerExecute(client, "SELECT count(*) AS n FROM customers", {
      ...opts(),
      format: "table",
      stdoutIsTTY: true,
    });
    expect(r.ok).toBe(true);
    expect(stdout()).toContain("│ n ");
  });

  it("acknowledges mutations on stdout (TTY) with details on stderr", async () => {
    const client = cannedClient({
      execute: {
        transactionId: 77,
        queryType: "insert",
        items: [],
        mutatedDocumentIds: ["c1", "c2"],
      },
    });
    const r = await runServerExecute(client, "INSERT INTO customers DOCUMENTS (:d)", {
      ...opts(),
      stdoutIsTTY: true,
    });
    expect(r.ok).toBe(true);
    expect(stdout()).toContain("OK");
    expect(stderr()).toContain("transactionId 77");
    expect(stderr()).toContain("2 documents mutated");
  });

  it("mutation OK goes to stderr when piped", async () => {
    const client = cannedClient({
      execute: { queryType: "delete", items: [], mutatedDocumentIds: [] },
    });
    const r = await runServerExecute(client, "DELETE FROM customers", opts());
    expect(r.ok).toBe(true);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("OK");
  });

  it("reports a DQL error from the response body as ok:false", async () => {
    const client = cannedClient({
      execute: {
        queryType: "unknown",
        items: [],
        mutatedDocumentIds: [],
        error: { description: "syntax error near SELEC" },
      },
    });
    const r = await runServerExecute(client, "SELEC broken", opts());
    expect(r.ok).toBe(false);
    expect(stderr()).toContain("syntax error near SELEC");
    expect(stderr()).toContain("in: SELEC broken");
    expect(stdout()).toBe("");
  });

  it("prints warnings from the response", async () => {
    const client = cannedClient({
      execute: {
        queryType: "select",
        items: [{ a: 1 }],
        mutatedDocumentIds: [],
        warnings: [{ description: "index missing" }],
        totalWarningsCount: 1,
      },
    });
    const r = await runServerExecute(client, "SELECT * FROM c", opts());
    expect(r.ok).toBe(true);
    expect(stderr()).toContain("warning: index missing");
  });

  it("caps rows with --max-rows and notes truncation", async () => {
    const client = cannedClient({
      execute: {
        queryType: "select",
        items: [{ n: 1 }, { n: 2 }, { n: 3 }],
        mutatedDocumentIds: [],
      },
    });
    const r = await runServerExecute(client, "SELECT * FROM c", {
      ...opts(),
      maxRows: 2,
      maxRowsExplicit: true,
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(stdout())).toHaveLength(2);
    expect(stderr()).toContain("showing first 2 of 3 rows");
  });

  it("writes -o files uncapped, without ANSI", async () => {
    const client = cannedClient({
      execute: {
        queryType: "select",
        items: [{ n: 1 }, { n: 2 }],
        mutatedDocumentIds: [],
      },
    });
    const out = path.join(dir, "out.json");
    const r = await runServerExecute(client, "SELECT * FROM c", { ...opts(), out });
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(stdout()).toContain("Wrote 2 rows");
  });

  it("surfaces -o write failures as ok:false", async () => {
    const client = cannedClient({
      execute: { queryType: "select", items: [{ n: 1 }], mutatedDocumentIds: [] },
    });
    const r = await runServerExecute(client, "SELECT * FROM c", {
      ...opts(),
      out: path.join(dir, "missing", "out.json"),
    });
    expect(r.ok).toBe(false);
    expect(stderr()).toContain("Cannot write");
  });

  it("--time prints a timing footer", async () => {
    const client = cannedClient({
      execute: { queryType: "select", items: [{ n: 1 }], mutatedDocumentIds: [] },
    });
    await runServerExecute(client, "SELECT * FROM c", { ...opts(), time: true });
    expect(stderr()).toMatch(/Time: \d+\.\d ms/);
  });

  it("propagates PortalApiError (HTTP layer) to the caller", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 401,
      statusText: "",
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: "bad key" }),
    });
    const client = new PortalClient({ baseUrl: "https://x.example/app", apiKey: "k", fetchImpl });
    await expect(runServerExecute(client, "SELECT 1", opts())).rejects.toBeInstanceOf(
      PortalApiError,
    );
  });

  it("propagates PortalConnectionError to the caller", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = new PortalClient({ baseUrl: "https://x.example/app", apiKey: "k", fetchImpl });
    await expect(runServerExecute(client, "SELECT 1", opts())).rejects.toBeInstanceOf(
      PortalConnectionError,
    );
  });
});

describe("runServerRemoteExecute", () => {
  it("renders the per-peer envelope as JSON", async () => {
    const client = cannedClient({
      remoteExecute: {
        result: [
          { peer: { peerKeyString: "pk1" }, elapsedMilliseconds: 5, items: [{ a: 1 }] },
          { peer: { peerKeyString: "pk2" }, elapsedMilliseconds: 8, items: [] },
        ],
      },
    });
    const r = await runServerRemoteExecute(client, "SYNC CONTEXT (… ) SELECT 1", opts());
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(stdout());
    expect(parsed).toHaveLength(2);
    expect(parsed[0].peer.peerKeyString).toBe("pk1");
  });

  it("counts peer errors and reports them on stderr", async () => {
    const client = cannedClient({
      remoteExecute: {
        result: [
          { peer: "pk1", items: [{ a: 1 }] },
          { peer: "pk2", error: { description: "boom" }, items: [] },
        ],
      },
    });
    const r = await runServerRemoteExecute(client, "SYNC CONTEXT (… ) SELECT 1", opts());
    expect(r.ok).toBe(false);
    expect(stderr()).toContain("1 of 2 peer(s) returned an error");
    expect(stdout()).toContain("boom");
  });

  it("handles a top-level error", async () => {
    const client = cannedClient({ remoteExecute: { error: { description: "no peers" } } });
    const r = await runServerRemoteExecute(client, "SYNC CONTEXT (… ) SELECT 1", opts());
    expect(r.ok).toBe(false);
    expect(stderr()).toContain("no peers");
  });

  it("empty result set is ok", async () => {
    const client = cannedClient({ remoteExecute: { result: [] } });
    const r = await runServerRemoteExecute(client, "SYNC CONTEXT (… ) SELECT 1", opts());
    expect(r.ok).toBe(true);
    expect(JSON.parse(stdout())).toEqual([]);
  });
});

describe("regression: adversarial review round 2", () => {
  it("a non-empty error object WITHOUT a string description still fails", async () => {
    const client = cannedClient({
      execute: {
        queryType: "unknown",
        items: [],
        mutatedDocumentIds: [],
        error: {} as { description?: string }, // cast: shape guard, see next line
      },
    });
    // {} alone is the documented "no error" sentinel — must PASS
    let r = await runServerExecute(client, "SELECT * FROM c", opts());
    expect(r.ok).toBe(true);

    const failing = cannedClient({
      execute: {
        queryType: "unknown",
        items: [],
        mutatedDocumentIds: [],
        error: { code: 42 } as unknown as { description: string },
      },
    });
    r = await runServerExecute(failing, "SELECT * FROM c", opts());
    expect(r.ok).toBe(false);
    expect(stderr()).toContain('{"code":42}');
  });

  it("remote-execute: description-less error objects fail (top-level and per-peer)", async () => {
    const topLevel = cannedClient({
      remoteExecute: { error: { code: "x" } as unknown as { description: string } },
    });
    let r = await runServerRemoteExecute(topLevel, "SYNC CONTEXT (…) SELECT 1", opts());
    expect(r.ok).toBe(false);
    expect(stderr()).toContain('{"code":"x"}');

    errSpy.mockClear();
    const perPeer = cannedClient({
      remoteExecute: {
        result: [
          { peer: "pk", error: { code: 7 } as unknown as { description: string }, items: [] },
        ],
      },
    });
    r = await runServerRemoteExecute(perPeer, "SYNC CONTEXT (…) SELECT 1", opts());
    expect(r.ok).toBe(false);
    expect(stderr()).toContain("1 of 1 peer(s) returned an error");
    expect(JSON.parse(stdout())[0].error).toBe('{"code":7}');
  });

  it("remote-execute passes per-peer warnings through", async () => {
    const client = cannedClient({
      remoteExecute: {
        result: [
          {
            peer: "pk1",
            items: [],
            warnings: [{ description: "slow" }],
            totalWarningsCount: 1,
          },
        ],
      },
    });
    const r = await runServerRemoteExecute(client, "SYNC CONTEXT (…) SELECT 1", opts());
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(stdout());
    expect(parsed[0].warnings).toEqual([{ description: "slow" }]);
    expect(parsed[0].totalWarningsCount).toBe(1);
  });

  it("-o + explicit --max-rows prints the capped note", async () => {
    const client = cannedClient({
      execute: {
        queryType: "select",
        items: [{ n: 1 }, { n: 2 }, { n: 3 }],
        mutatedDocumentIds: [],
      },
    });
    const out = path.join(dir, "capped.json");
    const r = await runServerExecute(client, "SELECT * FROM c", {
      ...opts(),
      out,
      maxRows: 2,
      maxRowsExplicit: true,
    });
    expect(r.ok).toBe(true);
    expect(stdout()).toContain("first 2 of 3 — --max-rows");
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toHaveLength(2);
  });
});

it("remote-execute: an explicit null per-peer error is not a failure (regression R3-1)", async () => {
  const client = cannedClient({
    remoteExecute: {
      result: [{ peer: "pk", error: null as never, items: [{ a: 1 }] }],
    },
  });
  const r = await runServerRemoteExecute(client, "SYNC CONTEXT (…) SELECT 1", opts());
  expect(r.ok).toBe(true);
  expect(JSON.parse(stdout())[0].items).toEqual([{ a: 1 }]);
});
