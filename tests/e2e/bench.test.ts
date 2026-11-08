import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

function cli(args: string[]) {
  return execa(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    reject: false,
    input: "",
  });
}

describe.skipIf(!hasDevCredentials)(`e2e: dittosh dql bench (${NO_CREDENTIALS})`, () => {
  let dir: string;
  beforeAll(async () => {
    dir = tmpDataDir("ditto-bench-e2e-");
    const r = await cli(["dql", "dataset", "load", "pos", "--docs", "100", "-d", dir]);
    expect(r.exitCode).toBe(0);
  }, 120_000);
  afterAll(() => rmrf(dir));

  it("--example writes a sample file to stdout without opening a store", async () => {
    const r = await cli(["dql", "bench", "--example", "pos"]);
    expect(r.exitCode).toBe(0);
    const file = JSON.parse(r.stdout);
    expect(file.pos_orders__insert__new_order.resetQueries.length).toBeGreaterThan(0);
  });

  it("runs the sample file: JSON results on stdout, progress on stderr", async () => {
    const file = path.join(dir, "pos-bench.json");
    expect((await cli(["dql", "bench", "--example", "pos", "-o", file])).exitCode).toBe(0);
    const r = await cli(["dql", "bench", "-f", file, "--runs", "5", "--warmup", "2", "-d", dir]);
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(rows).toHaveLength(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length);
    for (const row of rows) {
      expect(row).toMatchObject({ runs: 5, warmup: 2 });
      expect(row.p95_ms).toBeGreaterThan(0);
    }
    expect(r.stderr).toContain("Benchmarking 4 benchmarks: 5 timed runs each, 2 warmup runs.");
  });

  it("times a statement given on the command line (flags before bench too)", async () => {
    const r = await cli(["dql", "-d", dir, "bench", "SELECT * FROM locations", "--runs", "3"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)[0]).toMatchObject({
      benchmark: "SELECT * FROM locations",
      rows: 7,
    });
  });

  it("dataset run --runs benchmarks a catalog query", async () => {
    const r = await cli([
      "dql",
      "dataset",
      "run",
      "pos_orders__agg__count_all",
      "--runs",
      "3",
      "-d",
      dir,
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)[0]).toMatchObject({
      benchmark: "pos_orders__agg__count_all",
      runs: 3,
    });
  });

  it("--after-each undoes an insert after every run and leaves the store clean", async () => {
    const insert = "INSERT INTO locations VALUES ({'_id': 'bench-e2e', 'name': 'x'})";
    const undo = "EVICT FROM locations WHERE _id = 'bench-e2e'";
    const r = await cli([
      "dql",
      "bench",
      insert,
      "--runs",
      "5",
      "--warmup",
      "2",
      "--pre",
      undo,
      "--after-each",
      undo,
      "-d",
      dir,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("no resetQueries");
    expect(JSON.parse(r.stdout)[0]).toMatchObject({ runs: 5, warmup: 2 });
    const left = await cli([
      "dql",
      "SELECT count(*) AS n FROM locations WHERE _id = 'bench-e2e'",
      "-d",
      dir,
    ]);
    expect(JSON.parse(left.stdout)[0].n).toBe(0);
  });

  it("exits 1 when the query fails and 2 for usage errors", async () => {
    const bad = await cli(["dql", "bench", "SELECT * FROM", "--runs", "2", "-d", dir]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("failed in query");
    const usage = await cli(["dql", "bench", "-d", dir]);
    expect(usage.exitCode).toBe(2);
  });
});
