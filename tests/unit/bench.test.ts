import { describe, expect, it } from "vitest";
import { exampleBenchFile } from "../../src/bench/example.js";
import { type BenchStage, resultRows, runBenchmark } from "../../src/bench/runner.js";
import {
  type BenchSpec,
  BenchSpecError,
  cleanStatement,
  parseBenchFile,
  selectBenchmarks,
} from "../../src/bench/spec.js";
import { computeStats, decideWarmup, WARMUP_MAX } from "../../src/bench/stats.js";
import { DATASETS, getDataset } from "../../src/datasets/registry.js";
import type { QueryExecutor } from "../../src/ditto/session.js";

describe("computeStats", () => {
  it("matches the benchmark runners: true median, floor-indexed p95/p99, population stddev", () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // 1..100, unsorted
    const s = computeStats(samples);
    expect(s.mean).toBe(50.5);
    expect(s.p50).toBe(50.5);
    expect(s.p95).toBe(96); // sorted[95]
    expect(s.p99).toBe(100); // sorted[99]
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.stdDev).toBeCloseTo(28.866, 3);
  });

  it("handles odd counts and a single sample", () => {
    expect(computeStats([3, 1, 2]).p50).toBe(2);
    expect(computeStats([7])).toEqual({
      mean: 7,
      p50: 7,
      p95: 7,
      p99: 7,
      min: 7,
      max: 7,
      stdDev: 0,
    });
    expect(() => computeStats([])).toThrow();
  });
});

describe("decideWarmup", () => {
  it("fills ~250 ms, between 1 and 1000 runs", () => {
    expect(decideWarmup(1)).toBe(250);
    expect(decideWarmup(3)).toBe(84);
    expect(decideWarmup(500)).toBe(1);
    expect(decideWarmup(0.001)).toBe(WARMUP_MAX);
    expect(decideWarmup(0)).toBe(WARMUP_MAX);
    expect(decideWarmup(-1)).toBe(1);
  });
});

describe("parseBenchFile", () => {
  it("reads the benchmarks.json map shape and ignores the benchmark repo's extra keys", () => {
    const specs = parseBenchFile(
      JSON.stringify({
        by_rated: {
          query: "SELECT * FROM movies WHERE rated = 'PG';",
          category: "INDEX_SELECT",
          expected_count: 3,
          sql_equivalent: "SELECT 1",
          qb: { x: 1 },
          preQueries: ["CREATE INDEX r ON movies (rated)"],
          postQueries: "DROP INDEX r ON movies",
        },
      }),
      "f.json",
    );
    expect(specs).toEqual([
      {
        name: "by_rated",
        query: "SELECT * FROM movies WHERE rated = 'PG'",
        preQueries: ["CREATE INDEX r ON movies (rated)"],
        resetQueries: [],
        postQueries: ["DROP INDEX r ON movies"],
        description: undefined,
      },
    ]);
  });

  it("reads a list (names optional) and a single object", () => {
    const list = parseBenchFile(
      JSON.stringify([{ name: "a", query: "SELECT 1" }, { query: "SELECT 2" }]),
      "f",
    );
    expect(list.map((s) => s.name)).toEqual(["a", "benchmark_2"]);
    const one = parseBenchFile(
      JSON.stringify({
        query: "SELECT 1",
        description: "x",
        resetQueries: ["EVICT FROM t WHERE true"],
      }),
      "f",
    );
    expect(one[0]).toMatchObject({ name: "benchmark", description: "x" });
    expect(one[0]!.resetQueries).toEqual(["EVICT FROM t WHERE true"]);
  });

  it.each([
    ["not json", "{", /isn't valid JSON/],
    ["a scalar", "3", /must hold a JSON object or list/],
    ["no benchmarks", "{}", /has no benchmarks/],
    ["an empty list", "[]", /has no benchmarks/],
    ["a non-object entry", '{"a": 1}', /must be an object/],
    ["a missing query", '{"a": {"preQueries": []}}', /needs a "query"/],
    ["a blank query", '{"a": {"query": " ; "}}', /needs a "query"/],
    [
      "a misspelled key",
      '{"a": {"query": "SELECT 1", "prequeries": []}}',
      /did you mean "preQueries"/,
    ],
    [
      "a snake_case key",
      '{"a": {"query": "SELECT 1", "post_queries": []}}',
      /did you mean "postQueries"/,
    ],
    [
      "an unknown key",
      '{"a": {"query": "SELECT 1", "runs": 5}}',
      /unknown key "runs"\. Known keys/,
    ],
    ["a list that isn't one", '{"a": {"query": "SELECT 1", "preQueries": 5}}', /must be a list/],
    ["a blank statement", '{"a": {"query": "SELECT 1", "preQueries": [""]}}', /preQueries\[0\]/],
    ["a name inside a map entry", '{"a": {"query": "SELECT 1", "name": "b"}}', /goes in the key/],
    ["a blank name", '[{"query": "SELECT 1", "name": " "}]', /name must be a non-empty/],
    [
      "a non-string description",
      '[{"query": "SELECT 1", "description": 1}]',
      /description must be a string/,
    ],
    [
      "duplicate names",
      '[{"query": "SELECT 1", "name": "a"}, {"query": "SELECT 2", "name": "a"}]',
      /two benchmarks are named "a"/,
    ],
  ])("rejects %s", (_label, text, error) => {
    expect(() => parseBenchFile(text, "f.json")).toThrow(error);
    expect(() => parseBenchFile(text, "f.json")).toThrow(BenchSpecError);
  });

  it("cleanStatement trims and drops a trailing semicolon", () => {
    expect(cleanStatement("  SELECT 1 ;  ")).toBe("SELECT 1");
  });
});

describe("selectBenchmarks", () => {
  const specs = parseBenchFile('{"a": {"query": "SELECT 1"}, "b": {"query": "SELECT 2"}}', "f");
  it("keeps file order, all when no names are given", () => {
    expect(selectBenchmarks(specs, ["b", "a"]).map((s) => s.name)).toEqual(["a", "b"]);
    expect(selectBenchmarks(specs, [])).toBe(specs);
  });
  it("names unknown benchmarks and lists the real ones", () => {
    expect(() => selectBenchmarks(specs, ["c"])).toThrow(
      'No benchmark named "c". In this file: a, b',
    );
  });
});

/** A fake store: records statements, can fail on a pattern, advances a fake clock. */
function fakeSession(opts: { fail?: RegExp; rows?: number; costMs?: number } = {}) {
  const calls: string[] = [];
  let clock = 0;
  const session: QueryExecutor = {
    execute: async (s: string) => {
      calls.push(s);
      clock += opts.costMs ?? 2;
      if (opts.fail?.test(s)) throw Object.assign(new Error("boom"), { code: "query/x" });
      return { items: Array.from({ length: opts.rows ?? 1 }, () => ({})) } as never;
    },
  };
  return { session, calls, now: () => clock };
}

const spec = (over: Partial<BenchSpec> = {}): BenchSpec => ({
  name: "b",
  query: "SELECT * FROM t",
  preQueries: [],
  resetQueries: [],
  postQueries: [],
  ...over,
});

describe("runBenchmark", () => {
  it("runs pre once, reset before every warmup and timed run, post once", async () => {
    const f = fakeSession({ rows: 3 });
    const notes: string[] = [];
    const r = await runBenchmark(
      f.session,
      spec({ preQueries: ["PRE"], resetQueries: ["RESET"], postQueries: ["POST"] }),
      { runs: 2, warmup: 1, now: f.now, note: (m) => notes.push(m) },
    );
    expect(f.calls).toEqual([
      "PRE",
      "RESET",
      "SELECT * FROM t", // warmup
      "RESET",
      "SELECT * FROM t",
      "RESET",
      "SELECT * FROM t",
      "POST",
    ]);
    expect(r).toMatchObject({ ok: true, runs: 2, warmup: 1, rows: 3, samples: [2, 2] });
    expect(r.stats?.p50).toBe(2);
    expect(notes).toEqual(["  b: 1 warmup runs"]);
  });

  it("auto warmup sizes itself from a pilot run", async () => {
    const f = fakeSession({ costMs: 50 });
    const r = await runBenchmark(f.session, spec(), { runs: 1, warmup: "auto", now: f.now });
    expect(r.warmup).toBe(5); // 250 ms / 50 ms
    expect(f.calls).toHaveLength(6);
  });

  it("no warmup by default count 0, and no note", async () => {
    const f = fakeSession();
    const notes: string[] = [];
    const r = await runBenchmark(f.session, spec(), {
      runs: 1,
      warmup: 0,
      note: (m) => notes.push(m),
    });
    expect(r.warmup).toBe(0);
    expect(notes).toEqual([]);
  });

  it.each([
    ["pre", { preQueries: ["CREATE INDEX x"] }, /CREATE/],
    ["reset", { resetQueries: ["EVICT x"] }, /EVICT/],
    ["query", {}, /SELECT/],
  ] as [BenchStage, Partial<BenchSpec>, RegExp][])(
    "a failure in %s stops timing but still runs postQueries",
    async (stage, over, fail) => {
      const f = fakeSession({ fail });
      const r = await runBenchmark(f.session, spec({ ...over, postQueries: ["DROP INDEX x"] }), {
        runs: 3,
        warmup: 0,
      });
      expect(r.ok).toBe(false);
      expect(r.failure).toMatchObject({ stage, error: "[query/x] boom" });
      expect(r.stats).toBeUndefined();
      expect(f.calls.at(-1)).toBe("DROP INDEX x");
    },
  );

  it("a warmup failure is reported as warmup", async () => {
    const f = fakeSession({ fail: /SELECT/ });
    const r = await runBenchmark(f.session, spec(), { runs: 3, warmup: "auto" });
    expect(r.failure?.stage).toBe("warmup");
  });

  it("a failed postQuery marks the benchmark failed but keeps its timings", async () => {
    const f = fakeSession({ fail: /DROP/ });
    const r = await runBenchmark(f.session, spec({ postQueries: ["DROP INDEX x", "EVICT y"] }), {
      runs: 2,
      warmup: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBeUndefined();
    expect(r.cleanupFailures).toEqual([{ statement: "DROP INDEX x", error: "boom" }]);
    expect(r.stats).toBeDefined();
    expect(f.calls.at(-1)).toBe("EVICT y"); // later cleanup still runs
  });

  it("warns when a repeated write has no resetQueries", async () => {
    const warns: string[] = [];
    const write = spec({ query: "EVICT FROM t WHERE _id = 'x'" });
    await runBenchmark(fakeSession().session, write, {
      runs: 2,
      warmup: 0,
      warn: (m) => warns.push(m),
    });
    expect(warns[0]).toContain("no resetQueries");
    warns.length = 0;
    await runBenchmark(fakeSession().session, write, {
      runs: 1,
      warmup: 0,
      warn: (m) => warns.push(m),
    });
    await runBenchmark(
      fakeSession().session,
      { ...write, resetQueries: ["INSERT …"] },
      {
        runs: 5,
        warmup: "auto",
        warn: (m) => warns.push(m),
      },
    );
    await runBenchmark(fakeSession().session, spec(), {
      runs: 5,
      warmup: 0,
      warn: (m) => warns.push(m),
    });
    expect(warns).toEqual([]);
  });

  it("rethrows errors that aren't from a statement", async () => {
    const session: QueryExecutor = { execute: async () => ({}) as never }; // no items
    await expect(runBenchmark(session, spec(), { runs: 1, warmup: 0 })).rejects.toThrow(TypeError);
  });
});

describe("resultRows", () => {
  const ok = (name: string, samples: number[]) => ({
    name,
    ok: true,
    cleanupFailures: [],
    runs: samples.length,
    warmup: 0,
    rows: 4,
    samples,
    stats: samples.length > 0 ? computeStats(samples) : undefined,
  });

  it("one run shows just the time", () => {
    expect(resultRows([ok("a", [1.23456])])).toEqual([{ benchmark: "a", rows: 4, time_ms: 1.235 }]);
  });

  it("several runs show the distribution", () => {
    const [row] = resultRows([ok("a", [1, 2, 3, 4])]);
    expect(Object.keys(row!)).toEqual([
      "benchmark",
      "runs",
      "warmup",
      "rows",
      "mean_ms",
      "p50_ms",
      "p95_ms",
      "p99_ms",
      "min_ms",
      "max_ms",
      "stddev_ms",
    ]);
    expect(row).toMatchObject({ runs: 4, mean_ms: 2.5, p50_ms: 2.5, p95_ms: 4, max_ms: 4 });
  });

  it("adds a status column when anything failed", () => {
    const failed = {
      ...ok("b", []),
      ok: false,
      stats: undefined,
      runs: 0,
      failure: { stage: "pre" as const, statement: "x", error: "e" },
    };
    const cleanup = {
      ...ok("c", [1, 2]),
      ok: false,
      cleanupFailures: [{ statement: "y", error: "e" }],
    };
    const rows = resultRows([ok("a", [1, 2]), failed, cleanup]);
    expect(rows.map((r) => r.status)).toEqual(["ok", "failed (pre)", "cleanup failed"]);
    expect(rows[1]!.p95_ms).toBeNull();
    expect(resultRows([failed])[0]).toEqual({
      benchmark: "b",
      status: "failed (pre)",
      rows: 4,
      time_ms: null,
    });
  });
});

describe("exampleBenchFile", () => {
  it.each(DATASETS.map((d) => d.name))("%s: a valid file that teaches each part", (name) => {
    const file = exampleBenchFile(getDataset(name)!);
    const specs = parseBenchFile(JSON.stringify(file), name);
    expect(specs.length).toBeGreaterThanOrEqual(3);
    for (const [key, e] of Object.entries(file)) {
      expect(e.description.length, key).toBeGreaterThan(20);
      // Keys appear in the order they run.
      const order = Object.keys(e).filter((k) => k !== "description");
      const expected = ["preQueries", "resetQueries", "query", "postQueries"].filter((k) => k in e);
      expect(order, key).toEqual(expected);
      expect(JSON.stringify(e), key).not.toMatch(/\bDOCUMENTS\b/);
    }
    // A plain read, an indexed read (pre + post), and a write that is safe to repeat.
    expect(specs.some((s) => s.preQueries.length === 0 && s.query.startsWith("SELECT"))).toBe(true);
    expect(
      specs.some(
        (s) => s.preQueries.some((q) => q.startsWith("CREATE INDEX")) && s.postQueries.length > 0,
      ),
    ).toBe(true);
    const write = specs.find((s) => !s.query.startsWith("SELECT"));
    expect(write).toBeDefined();
    expect(write!.resetQueries.length + write!.postQueries.length).toBeGreaterThan(0);
  });

  it("pos uses resetQueries for its write; retail-joins includes a join", () => {
    const pos = parseBenchFile(JSON.stringify(exampleBenchFile(getDataset("pos")!)), "pos");
    expect(pos.find((s) => s.query.startsWith("INSERT"))?.resetQueries.length).toBeGreaterThan(0);
    const joins = exampleBenchFile(getDataset("retail-joins")!);
    expect(Object.values(joins).some((e) => /\bJOIN\b/.test(e.query))).toBe(true);
  });

  it("skips catalog queries with known issues", () => {
    const suite = getDataset("movies")!;
    const firstSelect = Object.entries(suite.catalog).find(([, q]) => q.category === "SELECT")![0];
    const file = exampleBenchFile({ ...suite, knownIssues: { [firstSelect]: "hangs" } });
    expect(Object.keys(file)).not.toContain(firstSelect);
  });
});
