import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

// Same pattern as cli-dataset.test.ts: mock only the native SDK boundary.
const h = vi.hoisted(() => ({
  calls: [] as string[],
  failPattern: null as RegExp | null,
}));

vi.mock("../../src/ditto/session.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/ditto/session.js")>();
  class FakeSession {
    static async open() {
      return new FakeSession();
    }
    async execute(statement: string) {
      h.calls.push(statement);
      if (h.failPattern?.test(statement)) throw new Error("injected failure");
      return { items: [{ value: { n: 1 } }] };
    }
    async close() {}
  }
  return { ...mod, DittoSession: FakeSession };
});

const { registerDqlGroup } = await import("../../src/cli/groups/dql/index.js");
const { parseWarmup } = await import("../../src/cli/groups/dql/bench.js");

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;
let dir: string;

beforeEach(() => {
  h.calls = [];
  h.failPattern = null;
  process.env.DATABASE_ID = "test-app";
  process.env.OFFLINE_TOKEN = "test-token";
  process.exitCode = undefined;
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  dir = tmpDataDir("ditto-bench-unit-");
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  writeSpy.mockRestore();
  rmrf(dir);
  process.exitCode = undefined;
});

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDqlGroup(program.command("dql"));
  await program.parseAsync(["node", "dittosh", "dql", ...args]);
}

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");
const json = () => JSON.parse(stdout().slice(stdout().indexOf("[")));

describe("dittosh dql bench", () => {
  it("times a statement with pre, reset, and post, and reports percentiles", async () => {
    await run(
      "bench",
      "SELECT * FROM t;",
      "--runs",
      "3",
      "--warmup",
      "1",
      "--pre",
      "CREATE INDEX i ON t (a)",
      "--reset",
      "EVICT FROM t WHERE _id = 'x'",
      "--post",
      "DROP INDEX i ON t",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBeUndefined();
    expect(h.calls[0]).toBe("CREATE INDEX i ON t (a)");
    expect(h.calls.filter((c) => c === "SELECT * FROM t")).toHaveLength(4);
    expect(h.calls.filter((c) => c.startsWith("EVICT"))).toHaveLength(4);
    expect(h.calls.at(-1)).toBe("DROP INDEX i ON t");
    const [row] = json();
    expect(row).toMatchObject({ benchmark: "SELECT * FROM t", runs: 3, warmup: 1, rows: 1 });
    expect(row.p99_ms).toEqual(expect.any(Number));
    expect(stderr()).toContain("Benchmarking 1 benchmark: 3 timed runs each, 1 warmup run.");
  });

  it("--before-each is --reset by another name; both keep the order given", async () => {
    await run(
      "bench",
      "EVICT FROM t WHERE _id = 'x'",
      "--runs",
      "2",
      "--before-each",
      "INSERT A",
      "--reset",
      "INSERT B",
      "--before-each",
      "INSERT C",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBeUndefined();
    const run1 = ["INSERT A", "INSERT B", "INSERT C", "EVICT FROM t WHERE _id = 'x'"];
    expect(h.calls).toEqual([...run1, ...run1]);
    expect(stderr()).not.toContain("no resetQueries");
  });

  it("defaults to 50 runs and no warmup; long statements get a short name", async () => {
    const long = `SELECT * FROM t WHERE ${"a = 1 AND ".repeat(10)}b = 2`;
    await run("bench", long, "-d", dir, "--format", "json");
    expect(h.calls).toHaveLength(50);
    expect(json()[0].benchmark).toHaveLength(60);
    expect(json()[0].benchmark.endsWith("…")).toBe(true);
  });

  it("one run prints just the time, with a tip about --runs", async () => {
    await run("bench", "SELECT 1", "--runs", "1", "-d", dir, "--format", "json");
    expect(Object.keys(json()[0])).toEqual(["benchmark", "rows", "time_ms"]);
    expect(stderr()).toContain("Use --runs <n>");
  });

  it("a statement swallowed by a bare --warmup still runs, with auto warmup", async () => {
    await run("bench", "--warmup", "SELECT 1", "--runs", "2", "-d", dir, "--format", "json");
    expect(process.exitCode).toBeUndefined();
    expect(json()[0].warmup).toBeGreaterThan(0);
    expect(stderr()).toContain("warmup to ~250 ms");
  });

  it("runs a benchmark file; --only picks entries; CLI --pre/--post wrap each one", async () => {
    const file = path.join(dir, "b.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        a: { query: "SELECT a FROM t", preQueries: ["PRE_A"], postQueries: ["POST_A"] },
        b: { query: "SELECT b FROM t" },
        c: { query: "SELECT c FROM t" },
      }),
    );
    await run(
      "bench",
      "-f",
      file,
      "--only",
      "a, c",
      "--runs",
      "2",
      "--pre",
      "PRE",
      "--post",
      "POST",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(json().map((r: { benchmark: string }) => r.benchmark)).toEqual(["a", "c"]);
    expect(h.calls.slice(0, 2)).toEqual(["PRE", "PRE_A"]);
    expect(h.calls.slice(4, 6)).toEqual(["POST_A", "POST"]);
    expect(h.calls).not.toContain("SELECT b FROM t");
  });

  it("writes results to a file with -o", async () => {
    const out = path.join(dir, "results.csv");
    await run("bench", "SELECT 1", "--runs", "2", "-o", out, "-d", dir);
    expect(fs.readFileSync(out, "utf8")).toMatch(/^benchmark,runs,warmup,rows,mean_ms,p50_ms/);
    expect(stdout()).toContain("Wrote 1 benchmark result to");
  });

  it("a failing benchmark exits 1, names the stage, and still cleans up", async () => {
    h.failPattern = /^SELECT/;
    await run(
      "bench",
      "SELECT 1",
      "--post",
      "DROP INDEX i ON t",
      "--runs",
      "2",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("failed in query: injected failure");
    expect(h.calls.at(-1)).toBe("DROP INDEX i ON t");
    expect(json()[0].status).toBe("failed (query)");
  });

  it("a failing cleanup statement is reported and exits 1", async () => {
    h.failPattern = /^DROP/;
    await run(
      "bench",
      "SELECT 1",
      "--post",
      "DROP INDEX i ON t",
      "--runs",
      "2",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("cleanup failed: injected failure");
  });

  it.each([
    [["bench"], "Give a statement to time, or -f <file>"],
    [["bench", "SELECT 1", "-f", "x.json"], "not both"],
    [["bench", "SELECT 1", "--only", "a"], "use it with -f"],
    [["bench", "SELECT 1", "--runs", "0"], "--runs must be an integer ≥ 1"],
    [["bench", "SELECT 1", "--runs", "10001"], "--runs must be at most 10,000"],
    [["bench", "SELECT 1", "--warmup", "lots"], '--warmup takes a number of runs or "auto"'],
    [["bench", "SELECT 1", "--format", "xml"], "--format must be one of"],
    [["bench", "SELECT 1", "-o", "/no/such/dir/x.json"], "no such directory"],
    [["bench", ";"], "The statement is empty."],
    [["bench", "-f", "/no/such/file.json"], "Cannot read /no/such/file.json"],
    [["bench", "--example", "nope"], "Unknown dataset: nope"],
    [["bench", "--example", "pos", "SELECT 1"], "--example only writes a sample file"],
    [["bench", "--example", "pos", "-o", "/no/such/dir/x.json"], "no such directory"],
  ])("usage error: %j", async (args, message) => {
    await run(...args, "-d", dir);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain(message);
    expect(h.calls).toEqual([]); // the store is never touched
  });

  it("a bad file is a usage error that names the problem", async () => {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, '{"a": {"query": "SELECT 1", "prequeries": []}}');
    await run("bench", "-f", file, "-d", dir);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain('did you mean "preQueries"');
  });

  it("--example prints a sample file to stdout", async () => {
    await run("bench", "--example", "pos");
    const text = writeSpy.mock.calls.flat().join("");
    const file = JSON.parse(text);
    expect(Object.keys(file)).toContain("pos_orders__insert__new_order");
    expect(h.calls).toEqual([]);
  });

  it("--example -o saves it and says how to run it", async () => {
    const out = path.join(dir, "retail.json");
    await run("bench", "--example", "retail", "-o", out);
    expect(Object.keys(JSON.parse(fs.readFileSync(out, "utf8"))).length).toBeGreaterThan(2);
    expect(stdout()).toContain("Wrote a sample benchmark file for retail");
    expect(stderr()).toContain("dittosh dql dataset load retail");
    expect(stderr()).toContain(`dittosh dql bench -f ${out} --runs 50 --warmup`);
  });

  it("parseWarmup: bare and auto adapt, numbers are exact, absent is undefined", () => {
    expect(parseWarmup(undefined)).toBeUndefined();
    expect(parseWarmup(false)).toBeUndefined();
    expect(parseWarmup(true)).toBe("auto");
    expect(parseWarmup("auto")).toBe("auto");
    expect(parseWarmup("=7")).toBe(7);
    expect(parseWarmup("0")).toBe(0);
  });
});

describe("dittosh dql dataset run --runs/--warmup", () => {
  it("benchmarks a read catalog query (index DDL only with --setup, kept afterwards)", async () => {
    await run(
      "dataset",
      "run",
      "filtered_query_with_index",
      "--dataset",
      "movies",
      "--runs",
      "3",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBeUndefined();
    expect(h.calls).toEqual(Array(3).fill("SELECT * FROM movies WHERE rated = 'PG'"));
    expect(json()[0]).toMatchObject({ benchmark: "filtered_query_with_index", runs: 3 });

    h.calls = [];
    outSpy.mockClear();
    await run(
      "dataset",
      "run",
      "filtered_query_with_index",
      "--dataset",
      "movies",
      "--runs",
      "2",
      "--setup",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(h.calls[1]).toBe("CREATE INDEX movies_rated ON movies (rated)");
    expect(h.calls.at(-1)).toBe("SELECT * FROM movies WHERE rated = 'PG'"); // no DROP
  });

  it("benchmarks a write with its fixtures, resets, and cleanup (needs --yes)", async () => {
    await run(
      "dataset",
      "run",
      "pos_orders__insert__new_order",
      "--warmup",
      "1",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBe(2);
    expect(h.calls).toEqual([]);

    process.exitCode = undefined;
    await run(
      "dataset",
      "run",
      "pos_orders__insert__new_order",
      "--warmup",
      "1",
      "--runs",
      "2",
      "--yes",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBeUndefined();
    const inserts = h.calls.filter((c) => c.startsWith("INSERT"));
    const evicts = h.calls.filter((c) => c.startsWith("EVICT"));
    expect(inserts).toHaveLength(3); // warmup + 2 runs
    expect(evicts).toHaveLength(4); // a reset before each + the cleanup
    expect(json()[0]).toMatchObject({ runs: 2, warmup: 1 });
  });

  it("shows a known-issue warning before benchmarking", async () => {
    await run(
      "dataset",
      "run",
      "joins__left__products_inventory_stock_value",
      "--runs",
      "2",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(stderr()).toContain("known issue");
  });

  it("a failing query exits 1", async () => {
    h.failPattern = /^SELECT/;
    await run(
      "dataset",
      "run",
      "filtered_query_with_index",
      "--dataset",
      "movies",
      "--runs",
      "2",
      "-d",
      dir,
      "--format",
      "json",
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [["--runs", "2", "--profile"], "don't combine with --runs/--warmup"],
    [["--warmup", "--time"], "don't combine with --runs/--warmup"],
    [["--runs", "2", "--max-rows", "5"], "--max-rows doesn't apply"],
    [["--runs", "nope"], "--runs must be an integer"],
    [["--runs", "2", "--format", "xml"], "--format must be one of"],
  ])("usage error: %j", async (flags, message) => {
    await run(
      "dataset",
      "run",
      "filtered_query_with_index",
      "--dataset",
      "movies",
      ...flags,
      "-d",
      dir,
    );
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain(message);
    expect(h.calls).toEqual([]);
  });
});
