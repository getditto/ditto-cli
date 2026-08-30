import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

// Same pattern as cli-dql.test.ts: mock only the native SDK boundary.
const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as Record<string, unknown>[],
}));

vi.mock("../../src/ditto/session.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/ditto/session.js")>();
  class FakeSession {
    static async open() {
      return new FakeSession();
    }
    async execute(statement: string) {
      h.calls.push(statement);
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
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "list", "--format", "json"]);
    expect(process.exitCode).toBeUndefined();
    const out = JSON.parse(stdout().slice(stdout().indexOf("[")));
    expect(out.map((d: { dataset: string }) => d.dataset)).toEqual(["movies", "retail", "retail-joins", "pos"]);
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
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "load", "movies", "--docs", "50", "-d", dataDir]);
    expect(process.exitCode).toBeUndefined();
    const inserts = h.calls.filter((c) => c.startsWith("INSERT INTO movies DOCUMENTS"));
    expect(inserts.length).toBeGreaterThan(0);
    expect(stdout()).toContain("Loaded 50 documents");
  });

  it("load validates --docs and dataset name (exit 2)", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "load", "movies", "--docs", "abc", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "load", "nope", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
  });

  it("run resolves a catalog query, echoes the statement, renders rows", async () => {
    h.rows = [{ _id: { title: "Blacksmith Scene", year: "1893" } }];
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "run", "single_result", "--dataset", "movies", "-d", dataDir]);
    expect(stderr()).toContain("SELECT * FROM movies WHERE _id.year = '1893'");
    expect(h.calls).toContain("SELECT * FROM movies WHERE _id.year = '1893'");
    expect(stdout()).toContain("Blacksmith Scene");
  });

  it("run --setup applies the catalog entry's preQueries first", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "run", "filtered_query_with_index", "--dataset", "movies", "--setup", "-d", dataDir]);
    const createIdx = h.calls.findIndex((c) => c.startsWith("CREATE INDEX"));
    const select = h.calls.findIndex((c) => c.startsWith("SELECT * FROM movies WHERE rated = 'PG'"));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(createIdx);
  });

  it("run rejects unknown and ambiguous query names (exit 2)", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "run", "nope__nope", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "run", "stores__select__all", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("multiple datasets");
  });

  it("run on a write-category query requires --yes; with --yes it applies cleanup", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "run", "insert", "--dataset", "movies", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("mutates the store");

    process.exitCode = undefined;
    h.calls = [];
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "run", "insert", "--dataset", "movies", "--yes", "-d", dataDir]);
    expect(process.exitCode).toBeUndefined();
    expect(h.calls.some((c) => c.startsWith("INSERT INTO movies"))).toBe(true);
    // postQueries cleanup (EVICT the bench doc) runs after
    expect(h.calls.some((c) => c.startsWith("EVICT FROM movies"))).toBe(true);
  });

  it("reset requires --yes and evicts each collection", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "reset", "movies", "-d", dataDir]);
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    h.calls = [];
    await buildProgram().parseAsync(["node", "ditto", "dql", "dataset", "reset", "movies", "--yes", "-d", dataDir]);
    expect(process.exitCode).toBeUndefined();
    expect(h.calls).toContain("EVICT FROM movies WHERE true");
    expect(stdout()).toContain("Reset movies");
  });
});
