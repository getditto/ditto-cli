import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

// Mock only the native SDK boundary; everything else runs for real.
const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  failWith: null as null | { message: string; code?: string },
  lockNextOpen: false,
  calls: [] as string[],
}));

vi.mock("../../src/ditto/session.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/ditto/session.js")>();
  class FakeSession {
    static async open() {
      if (h.lockNextOpen) {
        h.lockNextOpen = false;
        throw new mod.LockError("/fake/dir");
      }
      return new FakeSession();
    }
    async execute(statement: string) {
      h.calls.push(statement);
      if (h.failWith) {
        const err = new Error(h.failWith.message) as Error & { code?: string };
        err.code = h.failWith.code;
        throw err;
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
  h.rows = [];
  h.failWith = null;
  h.lockNextOpen = false;
  h.calls = [];
  process.env.DATABASE_ID = "test-app";
  process.env.OFFLINE_TOKEN = "test-token";
  process.exitCode = undefined;
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  dataDir = tmpDataDir("ditto-cli-unit-");
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

describe("ditto dql command wiring (mocked SDK boundary)", () => {
  it("one-shot SELECT renders rows as JSON (non-TTY) and exits 0", async () => {
    h.rows = [{ _id: "1", title: "Alien" }];
    await buildProgram().parseAsync(["node", "ditto", "dql", "SELECT * FROM movies", "-d", dataDir]);
    expect(process.exitCode).toBeUndefined();
    expect(stdout()).toContain('"Alien"');
  });

  it("mutation prints OK", async () => {
    h.rows = [];
    await buildProgram().parseAsync(["node", "ditto", "dql", "INSERT INTO movies DOCUMENTS ({'_id':'1'})", "-d", dataDir]);
    expect(stdout()).toBe("OK");
  });

  it("query error exits 1 with statement excerpt", async () => {
    h.failWith = { message: "bad syntax", code: "query/invalid" };
    await buildProgram().parseAsync(["node", "ditto", "dql", "SELEC broken", "-d", dataDir]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Query error [query/invalid]: bad syntax");
  });

  it("-f missing file exits 2", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "-f", "/nonexistent.dql", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("Cannot read file");
  });

  it("-f batch runs statements and prints a summary", async () => {
    const file = `${dataDir}/batch.dql`;
    fs.writeFileSync(file, "SELECT * FROM movies;\nSELECT * FROM movies;\n", "utf8");
    await buildProgram().parseAsync(["node", "ditto", "dql", "-f", file, "-d", dataDir]);
    expect(h.calls).toHaveLength(2);
    expect(stderr()).toContain("2 ok, 0 failed (of 2)");
  });

  it("-f batch failure exits 1", async () => {
    h.failWith = { message: "boom" };
    const file = `${dataDir}/batch.dql`;
    fs.writeFileSync(file, "SELECT * FROM movies;\n", "utf8");
    await buildProgram().parseAsync(["node", "ditto", "dql", "-f", file, "-d", dataDir]);
    expect(process.exitCode).toBe(1);
  });

  it("empty -f file exits 2", async () => {
    const file = `${dataDir}/empty.dql`;
    fs.writeFileSync(file, "-- only a comment\n", "utf8");
    await buildProgram().parseAsync(["node", "ditto", "dql", "-f", file, "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("No statements");
  });

  it("bad -p pair exits 2", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "SELECT * FROM movies", "-p", "noequals", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
  });

  it("lock error exits 4 with actionable message", async () => {
    h.lockNextOpen = true;
    await buildProgram().parseAsync(["node", "ditto", "dql", "SELECT * FROM movies", "-d", dataDir]);
    expect(process.exitCode).toBe(4);
    expect(stderr()).toContain("in use by another ditto process");
  });

  it("collections runs system:collections", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "collections", "-d", dataDir]);
    expect(h.calls).toEqual(["SELECT * FROM system:collections"]);
  });

  it("indexes without arg runs unfiltered system:indexes", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "indexes", "-d", dataDir]);
    expect(h.calls).toEqual(["SELECT * FROM system:indexes"]);
  });

  it("indexes with a collection filters via :param", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "indexes", "movies", "-d", dataDir]);
    expect(h.calls).toEqual(["SELECT * FROM system:indexes WHERE collection = :collection"]);
  });

  it("doctor prints all checks and exits 0 when healthy", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "doctor", "-d", dataDir]);
    expect(process.exitCode).toBe(0);
    for (const label of ["platform", "node", "data directory", "token"]) {
      expect(stdout()).toContain(label);
    }
  });

  it("doctor exits 3 when a check fails", async () => {
    delete process.env.DATABASE_ID;
    delete process.env.OFFLINE_TOKEN;
    delete process.env.DITTO_APP_ID;
    delete process.env.DQL_OFFLINE_LICENSE;
    await buildProgram().parseAsync(["node", "ditto", "dql", "doctor", "-d", dataDir]);
    expect(process.exitCode).toBe(3);
    expect(stdout()).toContain("✗ token");
  });
});
