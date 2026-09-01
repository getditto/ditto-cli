import fs from "node:fs";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

// Mock only the native SDK boundary; everything else runs for real.
const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  failWith: null as null | { message: string; code?: string },
  lockNextOpen: false,
  calls: [] as string[],
  openedDataDir: null as string | null,
}));

vi.mock("../../src/ditto/session.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/ditto/session.js")>();
  class FakeSession {
    static async open(_identity: unknown, dataDir: string) {
      h.openedDataDir = dataDir;
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
  h.openedDataDir = null;
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
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(stdout()).toContain('"Alien"');
  });

  it("mutation prints OK", async () => {
    h.rows = [];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "INSERT INTO movies DOCUMENTS ({'_id':'1'})",
      "-d",
      dataDir,
    ]);
    expect(stderr()).toBe("OK");
  });

  it("query error exits 1 with statement excerpt", async () => {
    h.failWith = { message: "bad syntax", code: "query/invalid" };
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELEC broken",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Query error [query/invalid]: bad syntax");
  });

  it("-f missing file exits 2", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "-f",
      "/nonexistent.dql",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("Cannot read file");
  });

  it("-f batch runs statements and prints a summary", async () => {
    const file = `${dataDir}/batch.dql`;
    fs.writeFileSync(file, "SELECT * FROM movies;\nSELECT * FROM movies;\n", "utf8");
    await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "-f", file, "-d", dataDir]);
    expect(h.calls).toHaveLength(2);
    expect(stderr()).toContain("2 ok, 0 failed (of 2)");
  });

  it("-f batch failure exits 1", async () => {
    h.failWith = { message: "boom" };
    const file = `${dataDir}/batch.dql`;
    fs.writeFileSync(file, "SELECT * FROM movies;\n", "utf8");
    await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "-f", file, "-d", dataDir]);
    expect(process.exitCode).toBe(1);
  });

  it("empty -f file exits 2", async () => {
    const file = `${dataDir}/empty.dql`;
    fs.writeFileSync(file, "-- only a comment\n", "utf8");
    await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "-f", file, "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("No statements");
  });

  it("-p BEFORE the positional statement still binds params (non-variadic collector)", async () => {
    h.rows = [{ n: 1 }];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "-p",
      "x=1",
      "SELECT * FROM movies",
      "-d",
      dataDir,
    ]);
    expect(h.calls).toEqual(["SELECT * FROM movies"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("trailing partial text after a complete statement exits 2 (never silently dropped)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT 1; GARBAGE TRAILING",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("trailing text");
    expect(h.calls).toHaveLength(0); // nothing executed
  });

  // R9 regression: rewrite output must survive real commander parsing (the
  // default-command unit tests alone pinned a shape commander REJECTED).
  it("rewritten argv parses and executes correctly end-to-end (in-process)", async () => {
    const { rewriteDefaultSubcommand } = await import("../../src/cli/default-command.js");
    const cases: [string[], string | undefined][] = [
      // [user argv, expected executed statement (undefined = no query)]
      [["dql", "-d", dataDir, "SELECT * FROM movies"], "SELECT * FROM movies"],
      [["dql", "--format", "json", "SELECT 1"], "SELECT 1"],
      [["dql", "SELECT 1", "-d", dataDir], "SELECT 1"],
      [["dql", "--execute=SELECT 1 LIMIT 1", "-d", dataDir], "SELECT 1 LIMIT 1"],
      [["dql", '--args={"n": 1}', "SELECT 1"], "SELECT 1"],
      [["dql", "--", "SELECT 1"], "SELECT 1"],
    ];
    for (const [argv, expectedStmt] of cases) {
      h.calls = [];
      h.rows = [{ n: 1 }];
      process.exitCode = undefined;
      const rewritten = rewriteDefaultSubcommand(argv.slice(0));
      await buildProgram().parseAsync(["node", "ditto", ...rewritten]);
      if (expectedStmt !== undefined) {
        expect(h.calls, JSON.stringify(argv)).toContain(expectedStmt);
        expect(process.exitCode, JSON.stringify(argv)).toBeUndefined();
      }
    }
  });

  it("user-typed ADVISE with -o is a usage error (exit 2)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "ADVISE SELECT * FROM movies",
      "-o",
      `${dataDir}/adv.json`,
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("can't be combined with -o");
  });

  it("-d with '--' as its value is a usage error (no store at $PWD/--)", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "-d", "--", "SELECT 1"]);
    // the rewrite turns "-d --" into exec's missing value → commander error (exit 2)
    expect(process.exitCode).toBe(2);
  });

  it("a positional that IS a comment works via the -- separator", async () => {
    h.rows = [{ n: 1 }];
    // as rewritten by rewriteDefaultSubcommand: flags before --, statement after
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "-d",
      dataDir,
      "--",
      "-- report\nSELECT 1",
    ]);
    expect(h.calls).toEqual(["-- report\nSELECT 1"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("whitespace/comment-only positional exits 2 without opening the store", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "   ", "-d", dataDir]);
    expect(process.exitCode).toBe(2);
    expect(h.openedDataDir).toBeNull();

    process.exitCode = undefined;
    // comment-only input via -e (a positional starting with '--' is an option to commander)
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "-e",
      "-- just a comment",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(h.openedDataDir).toBeNull();
  });

  it("collections exits 1 when the query fails", async () => {
    h.failWith = { message: "boom" };
    await buildProgram().parseAsync(["node", "ditto", "dql", "collections", "-d", dataDir]);
    expect(process.exitCode).toBe(1);
  });

  it("--advise with -o is a usage error (exit 2)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies",
      "--advise",
      "-o",
      `${dataDir}/x.json`,
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("can't be combined with -o");
  });

  it("bad -p pair exits 2", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies",
      "-p",
      "noequals",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("trailing semicolon on a one-shot is stripped (SDK rejects it otherwise)", async () => {
    h.rows = [{ n: 1 }];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies;",
      "-d",
      dataDir,
    ]);
    expect(h.calls[0]).toBe("SELECT * FROM movies");
    expect(process.exitCode).toBeUndefined();
  });

  it("multiple statements in argv exit 2 (use -f or stdin)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT 1; SELECT 2;",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("multiple statements");
  });

  it("-f with a positional statement is a usage error (exit 2)", async () => {
    const file = `${dataDir}/x.dql`;
    fs.writeFileSync(file, "SELECT * FROM movies;\n", "utf8");
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies",
      "-f",
      file,
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("cannot be combined");
  });

  it("-e/--execute works as the explicit statement form", async () => {
    h.rows = [{ n: 1 }];
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "-e",
      "SELECT * FROM movies",
      "-d",
      dataDir,
    ]);
    expect(h.calls[0]).toBe("SELECT * FROM movies");
  });

  it("positional + -e together is a usage error", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT 1",
      "-e",
      "SELECT 2",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("bogus --format exits 2 (never writes 'undefined' anywhere)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies",
      "--format",
      "yaml",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--format");
  });

  it("bogus --max-rows exits 2", async () => {
    for (const bad of ["abc", "-1", "0"]) {
      process.exitCode = undefined;
      await buildProgram().parseAsync([
        "node",
        "ditto",
        "dql",
        "exec",
        "SELECT * FROM movies",
        "--max-rows",
        bad,
        "-d",
        dataDir,
      ]);
      expect(process.exitCode).toBe(2);
    }
  });

  it("-o targeting an existing DIRECTORY exits 2 before opening the store", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies",
      "-o",
      dataDir,
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("that's a directory");
    expect(h.openedDataDir).toBeNull();
  });

  it("mutation with -o is a usage error (exit 2, nothing written)", async () => {
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "INSERT INTO movies DOCUMENTS ({'_id':'1'})",
      "-o",
      `${dataDir}/out.json`,
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("row-producing");
  });

  it("-o with a multi-statement batch exits 2 instead of overwriting per statement", async () => {
    const file = `${dataDir}/two.dql`;
    fs.writeFileSync(file, "SELECT * FROM movies;\nSELECT * FROM stores;\n", "utf8");
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "-f",
      file,
      "-o",
      `${dataDir}/out.json`,
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--out is only supported for a single statement");
    expect(fs.existsSync(`${dataDir}/out.json`)).toBe(false);
  });

  it("platform/SDK-load failure maps to exit 3", async () => {
    const { PlatformError } = await import("../../src/ditto/session.js");
    // fake a platform failure by making FakeSession.open throw it
    const mod = await import("../../src/ditto/session.js");
    const spy = vi
      .spyOn(mod.DittoSession, "open")
      .mockRejectedValueOnce(new PlatformError("Cannot find native binding"));
    await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "SELECT 1", "-d", dataDir]);
    expect(process.exitCode).toBe(3);
    expect(stderr()).toContain("could not load");
    spy.mockRestore();
  });

  it("TTY -f '' exits 2 (never drops into the REPL)", async () => {
    const origIn = process.stdin.isTTY;
    const origOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "-f", "", "-d", dataDir]);
      expect(process.exitCode).toBe(2);
      expect(stderr()).toContain("-f/--file requires a path");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIn, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: origOut, configurable: true });
    }
  });

  it("REPL path rejects --apply (prompt would race readline) unless -y", async () => {
    // simulate: no statement, no file, both TTYs — the REPL branch
    const origIn = process.stdin.isTTY;
    const origOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await buildProgram().parseAsync([
        "node",
        "ditto",
        "dql",
        "exec",
        "--advise",
        "--apply",
        "-d",
        dataDir,
      ]);
      expect(process.exitCode).toBe(2);
      expect(stderr()).toContain("--apply prompts");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIn, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: origOut, configurable: true });
    }
  });

  it("-d '' (empty) falls through to env; bogus env is still guarded", async () => {
    process.env.DITTO_DATA_DIR = "--";
    try {
      await buildProgram().parseAsync(["node", "ditto", "dql", "exec", "SELECT 1", "-d", ""]);
      expect(process.exitCode).toBe(2);
      expect(h.openedDataDir).toBeNull();
    } finally {
      delete process.env.DITTO_DATA_DIR;
    }
  });

  it("collections rejects -d '--' (commander artifact) without creating ./--", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "collections", "-d", "--"]);
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("requires a directory path");
    expect(h.openedDataDir).toBeNull();
  });

  it("lock error exits 4 with actionable message", async () => {
    h.lockNextOpen = true;
    await buildProgram().parseAsync([
      "node",
      "ditto",
      "dql",
      "exec",
      "SELECT * FROM movies",
      "-d",
      dataDir,
    ]);
    expect(process.exitCode).toBe(4);
    expect(stderr()).toContain("in use by another ditto process");
  });

  it("collections runs system:collections", async () => {
    await buildProgram().parseAsync(["node", "ditto", "dql", "collections", "-d", dataDir]);
    expect(h.calls).toEqual(["SELECT * FROM system:collections"]);
  });

  it("subcommand flags reach the subcommand (regression: parent option swallowing)", async () => {
    h.rows = [{ name: "movies" }];
    await buildProgram().parseAsync(["node", "ditto", "dql", "collections", "-d", dataDir]);
    expect(h.openedDataDir).toBe(dataDir);
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
