import fs from "node:fs";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

// Same pattern as cli-dql.test.ts: mock only the native SDK boundary.
const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as Record<string, unknown>[],
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
      if (h.failPattern?.test(statement)) {
        throw new Error("injected failure");
      }
      return { items: h.rows.map((value) => ({ value })) };
    }
    async close() {}
  }
  return { ...mod, DittoSession: FakeSession };
});

const { registerDqlGroup } = await import("../../src/cli/groups/dql/index.js");

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let dataDir: string;

beforeEach(() => {
  h.calls = [];
  h.rows = [];
  h.failPattern = null;
  process.env.DATABASE_ID = "test-app";
  process.env.OFFLINE_TOKEN = "test-token";
  process.exitCode = undefined;
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  dataDir = tmpDataDir("ditto-ds-unit-");
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmrf(dataDir);
});

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const dql = program.command("dql");
  registerDqlGroup(dql);
  return program;
}

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

describe("ditto dql dataset wiring (mocked SDK boundary)", () => {
  it("list renders all four datasets (json)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "list",
      "--format",
      "json",
    ]);
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(stdout().slice(stdout().indexOf("[")));
    expect(out.map((d: { dataset: string }) => d.dataset)).toEqual([
      "movies",
      "retail",
      "retail-joins",
      "pos",
    ]);
  });

  it("show prints shape, indexes, and catalog; unknown dataset exits 2", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "show", "movies"]);
    expect(stdout()).toContain("composite _id");
    expect(stdout()).toContain("single_result");
    expect(stdout()).toContain("CREATE INDEX movies_rated");

    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "show", "nope"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("Unknown dataset");
  });

  it("load generates and batch-inserts documents", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "movies",
      "--docs",
      "50",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBeUndefined();
    const inserts = h.calls.filter((c) => c.startsWith("INSERT INTO movies DOCUMENTS"));
    expect(inserts.length).toBeGreaterThan(0);
    expect(stdout()).toContain("Loaded 50 documents");
  });

  it("load validates --docs and dataset name (exit 2)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "movies",
      "--docs",
      "abc",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "nope",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("run resolves a catalog query, echoes the statement, renders rows", async () => {
    h.rows = [{ _id: { title: "Blacksmith Scene", year: "1893" } }];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "single_result",
      "--dataset",
      "movies",
      "-d",
      dataDir,
    ]);
    expect(stderr()).toContain("SELECT * FROM movies WHERE _id.year = '1893'");
    expect(h.calls).toContain("SELECT * FROM movies WHERE _id.year = '1893'");
    expect(stdout()).toContain("Blacksmith Scene");
  });

  it("write-category entries run preQueries (fixture INSERTs) even without --setup", async () => {
    // movies update_single carries its target INSERT in preQueries
    h.calls = [];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "update_single",
      "--dataset",
      "movies",
      "--yes",
      "-d",
      dataDir,
    ]);
    const inserts = h.calls.filter((c) => c.startsWith("INSERT INTO movies"));
    const updates = h.calls.filter((c) => c.startsWith("UPDATE movies"));
    const cleanups = h.calls.filter((c) => c.startsWith("EVICT FROM movies"));
    expect(inserts.length).toBeGreaterThan(0);
    expect(updates.length).toBe(1);
    expect(cleanups.length).toBeGreaterThan(0);
    // order: insert → update → evict
    expect(h.calls.indexOf(inserts[0]!)).toBeLessThan(h.calls.indexOf(updates[0]!));
    expect(h.calls.indexOf(updates[0]!)).toBeLessThan(h.calls.indexOf(cleanups[0]!));
  });

  it("fixture/cleanup statements run with diagnostics stripped (no repeated notes)", async () => {
    h.calls = [];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "update_single",
      "--dataset",
      "movies",
      "--yes",
      "--profile",
      "-d",
      dataDir,
    ]);
    // --profile produces one "not profilable" note for the mutation, not one per fixture
    const notes =
      errSpy.mock.calls
        .flat()
        .join("\n")
        .match(/only SELECT statements are profilable/g) ?? [];
    expect(notes.length).toBe(1);
  });

  it("write-entry cleanup runs even when the main query fails", async () => {
    h.failPattern = /^UPDATE/; // the measured statement fails
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "update_single",
      "--dataset",
      "movies",
      "--yes",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(1);
    // the fixture doc's EVICT still ran (no bench residue)
    expect(
      h.calls.some((c) =>
        c.startsWith("EVICT FROM movies WHERE plot = 'update-test-benchmark-uuid'"),
      ),
    ).toBe(true);
  });

  it("read-category runs do NOT run postQueries (no silent schema teardown)", async () => {
    // year_filter_with_index: preQueries = [DROP IF EXISTS, CREATE], postQueries = [DROP]
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "year_filter_with_index",
      "--dataset",
      "movies",
      "--setup",
      "-d",
      dataDir,
    ]);
    // preQueries legitimately DROP first (benchmark reset pattern); the trailing
    // postQuery DROP must NOT run — the index survives the run.
    expect(h.calls.filter((c) => c.startsWith("DROP INDEX")).length).toBe(1); // the preQuery only
    expect(h.calls.some((c) => c.startsWith("CREATE INDEX movies_year"))).toBe(true);
    expect(h.calls.at(-1)).toBe("SELECT * FROM movies WHERE _id.year > '2000'");
  });

  it("dataset list with a bogus --format exits 2", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "list",
      "--format",
      "yaml",
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("run --setup applies the catalog entry's preQueries first", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "filtered_query_with_index",
      "--dataset",
      "movies",
      "--setup",
      "-d",
      dataDir,
    ]);
    const createIdx = h.calls.findIndex((c) => c.startsWith("CREATE INDEX"));
    const select = h.calls.findIndex((c) =>
      c.startsWith("SELECT * FROM movies WHERE rated = 'PG'"),
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(createIdx);
  });

  it("run rejects unknown and ambiguous query names (exit 2)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "nope__nope",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "stores__select__all",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("multiple datasets");
  });

  it("run on a write-category query requires --yes; with --yes it applies cleanup", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "insert",
      "--dataset",
      "movies",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("mutates the store");

    process.exitCode = undefined;
    h.calls = [];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "insert",
      "--dataset",
      "movies",
      "--yes",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(h.calls.some((c) => c.startsWith("INSERT INTO movies"))).toBe(true);
    // postQueries cleanup (EVICT the bench doc) runs after
    expect(h.calls.some((c) => c.startsWith("EVICT FROM movies"))).toBe(true);
  });

  it("reset requires --yes and evicts each collection", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "reset",
      "movies",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    h.calls = [];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "reset",
      "movies",
      "--yes",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(h.calls).toContain("EVICT FROM movies WHERE true");
    expect(stdout()).toContain("Reset movies");
  });

  it("load rejects --docs above the proven heap ceiling (exit 2, no OOM)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "movies",
      "--docs",
      "3000000",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("at most");
  });

  it("load rejects --seed above 2^32-1 (would silently alias)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "movies",
      "--seed",
      "4294967296",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("dataset run --time prints timing once (no duplicate)", async () => {
    h.rows = [{ n: 1 }];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "single_result",
      "--dataset",
      "movies",
      "--time",
      "-d",
      dataDir,
    ]);
    const timingLines = stderr()
      .split("\n")
      .filter((l: string) => /\d+\.\d ms/.test(l));
    expect(timingLines).toHaveLength(1);
  });

  it("load accepts --seed 0 (valid seed)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "movies",
      "--docs",
      "5",
      "--seed",
      "0",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(stdout()).toContain("Loaded 5 documents");
  });

  it("load validates --batch-size and --seed (no hangs, exit 2)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "movies",
      "--batch-size",
      "0",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "load",
      "movies",
      "--seed",
      "abc",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("dataset run honors -o (writes results file)", async () => {
    h.rows = [{ _id: "1" }];
    const out = `${dataDir}/r.json`;
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "single_result",
      "--dataset",
      "movies",
      "-o",
      out,
      "-d",
      dataDir,
    ]);
    expect(fs.existsSync(out)).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([{ _id: "1" }]);
  });

  it("dataset run reports postQueries cleanup failures (exit 1)", async () => {
    h.failPattern = /^EVICT/; // insert's postQueries EVICT fails
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "insert",
      "--dataset",
      "movies",
      "--yes",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("cleanup failed");
  });

  it("known-issue warnings survive --quiet (they're the only mitigation for an SDK hang)", async () => {
    process.env.DITTO_QUIET = "1";
    try {
      await buildProgram().parseAsync([
        "node",
        "ditto",
        "dql",
        "dataset",
        "run",
        "joins__left__products_inventory_stock_value",
        "--dataset",
        "retail-joins",
        "-d",
        dataDir,
      ]);
      expect(stderr()).toContain("known issue");
      expect(stderr()).not.toContain("Running"); // banner suppressed, warning not
    } finally {
      delete process.env.DITTO_QUIET;
    }
  });

  it("dataset run warns on known-issue catalog entries", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "joins__left__products_inventory_stock_value",
      "--dataset",
      "retail-joins",
      "-d",
      dataDir,
    ]);
    expect(stderr()).toContain("known issue");
    expect(stderr()).toContain("SDK 5.1.0");
  });

  it("dataset run accepts -o=<path> (short-option = form)", async () => {
    h.rows = [{ n: 1 }];
    const out = `${dataDir}/r.json`;
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "single_result",
      "--dataset",
      "movies",
      `-o=${out}`,
      "-d",
      dataDir,
    ]);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("dataset run validates --max-rows (exit 2)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "dataset",
      "run",
      "single_result",
      "--dataset",
      "movies",
      "--max-rows",
      "abc",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
  });
});
