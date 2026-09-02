import fs from "node:fs";
import path from "node:path";
import type { QueryResult } from "@dittolive/ditto";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunOptions, runStatement } from "../../src/cli/groups/dql/run.js";
import type { QueryExecutor } from "../../src/ditto/session.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

function fakeExecutor(rows: Record<string, unknown>[]): QueryExecutor {
  return {
    execute: async () => ({ items: rows.map((value) => ({ value })) }) as unknown as QueryResult,
  };
}

function failingExecutor(message: string, code = "query/invalid"): QueryExecutor {
  return {
    execute: async () => {
      const err = new Error(message) as Error & { code?: string };
      err.code = code;
      throw err;
    },
  };
}

const FAKE_ENVELOPE = {
  "~request_profile": {
    _id: "prof-1",
    queryType: "select",
    state: "completed",
    resultCount: 2,
    times: { elapsed: 1_670_000, parse: 46_210, plan: 136_880, start: "2026-08-29T17:55:49Z" },
    plan: {
      "#operator": "sequence",
      children: [
        {
          "#operator": "scan",
          collection: "movies",
          "#stats": { documentsOut: 2, phaseTimes: { exec: 100_000 } },
          children: [],
        },
        {
          "#operator": "filter",
          condition: "rated = 'PG'",
          "#stats": { documentsIn: 2, documentsOut: 2, phaseTimes: { exec: 900_000 } },
          children: [],
        },
      ],
    },
  },
};

function profileExecutor(rows: Record<string, unknown>[], withEnvelope = true) {
  const calls: string[] = [];
  const executor: QueryExecutor = {
    execute: async (statement: string) => {
      calls.push(statement);
      const items = rows.map((value) => ({ value }));
      if (withEnvelope && statement.startsWith("PROFILE ")) {
        items.push({ value: FAKE_ENVELOPE });
      }
      if (statement.startsWith("EXPLAIN ")) {
        return {
          items: [{ value: { plan: { operator: "sequence", children: [] } } }],
        } as unknown as QueryResult;
      }
      return { items } as unknown as QueryResult;
    },
  };
  return { executor, calls };
}

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
});

const baseOpts: RunOptions = { maxRows: 10_000, maxRowsExplicit: false, interactive: false };

describe("runStatement", () => {
  it("renders JSON rows to stdout", async () => {
    const r = await runStatement(
      fakeExecutor([{ _id: "1", title: "Alien" }]),
      "SELECT * FROM movies",
      {
        ...baseOpts,
        format: "json",
      },
    );
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(1);
    expect(outSpy).toHaveBeenCalledWith(JSON.stringify([{ _id: "1", title: "Alien" }], null, 2));
  });

  it("renders a table for table format", async () => {
    const r = await runStatement(fakeExecutor([{ _id: "1" }]), "SELECT * FROM movies", {
      ...baseOpts,
      format: "table",
    });
    expect(r.ok).toBe(true);
    expect(outSpy.mock.calls[0]![0]).toContain("┌");
  });

  it("prints OK for mutations with no rows", async () => {
    const r = await runStatement(fakeExecutor([]), "INSERT INTO movies DOCUMENTS ({})", baseOpts);
    expect(r.ok).toBe(true);
    expect(errSpy).toHaveBeenCalledWith("OK");
  });

  it("selects with zero rows render as a result, not OK", async () => {
    await runStatement(fakeExecutor([]), "SELECT * FROM movies", {
      ...baseOpts,
      format: "table",
    });
    expect(outSpy).toHaveBeenCalledWith("(no rows)");
  });

  it("truncates at maxRows with a stderr banner", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ n: i }));
    const r = await runStatement(fakeExecutor(rows), "SELECT * FROM movies", {
      ...baseOpts,
      maxRows: 2,
      format: "json",
    });
    expect(r.rows).toBe(2);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("showing first 2 of 5");
  });

  it("writes results to -o file and prints a summary", async () => {
    const dir = tmpDataDir("ditto-run-");
    try {
      const out = path.join(dir, "out.json");
      const r = await runStatement(fakeExecutor([{ _id: "1" }]), "SELECT * FROM movies", {
        ...baseOpts,
        out,
      });
      expect(r.ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([{ _id: "1" }]);
      expect(outSpy.mock.calls.flat().join(" ")).toContain("Wrote 1 row to");
    } finally {
      rmrf(dir);
    }
  });

  it("returns ok:false and prints the error + statement on query failure", async () => {
    const r = await runStatement(failingExecutor("bad syntax"), "SELEC broken", baseOpts);
    expect(r.ok).toBe(false);
    const errOut = errSpy.mock.calls.flat().join("\n");
    expect(errOut).toContain("Query error [query/invalid]: bad syntax");
    expect(errOut).toContain("in: SELEC broken");
  });

  it("warns once about SELECT without LIMIT when interactive, then persists the flag", async () => {
    process.env.DITTO_CONFIG_DIR = tmpDataDir("ditto-state-");
    try {
      vi.resetModules();
      const opts: RunOptions = { ...baseOpts, interactive: true, format: "json" };
      await runStatement(fakeExecutor([{ _id: "1" }]), "SELECT * FROM movies", opts);
      expect(errSpy.mock.calls.flat().join("\n")).toContain("no LIMIT");

      errSpy.mockClear();
      await runStatement(fakeExecutor([{ _id: "1" }]), "SELECT * FROM movies", opts);
      expect(errSpy.mock.calls.flat().join("\n")).not.toContain("no LIMIT");
    } finally {
      rmrf(process.env.DITTO_CONFIG_DIR);
      delete process.env.DITTO_CONFIG_DIR;
    }
  });

  it("never warns when LIMIT present, --max-rows explicit, or non-interactive", async () => {
    process.env.DITTO_CONFIG_DIR = tmpDataDir("ditto-state-");
    try {
      const withLimit = await runStatement(fakeExecutor([]), "SELECT * FROM movies LIMIT 5", {
        ...baseOpts,
        interactive: true,
        format: "json",
      });
      expect(withLimit.ok).toBe(true);
      const explicit = await runStatement(fakeExecutor([]), "SELECT * FROM movies", {
        ...baseOpts,
        interactive: true,
        maxRowsExplicit: true,
        format: "json",
      });
      expect(explicit.ok).toBe(true);
      const piped = await runStatement(fakeExecutor([]), "SELECT * FROM movies", baseOpts);
      expect(piped.ok).toBe(true);
      expect(errSpy.mock.calls.flat().join("\n")).not.toContain("no LIMIT");
    } finally {
      rmrf(process.env.DITTO_CONFIG_DIR);
      delete process.env.DITTO_CONFIG_DIR;
    }
  });
});

describe("batch dot-command stripping (regression: glue-and-swallow)", () => {
  it("a dot-command line without a semicolon never eats the next statement", async () => {
    const { stripDotCommandLines } = await import("../../src/cli/groups/dql/batch.js");
    const { splitStatements } = await import("../../src/query/split.js");
    const text =
      'INSERT INTO t DOCUMENTS ([{"_id":"one"}]);\n.exit\nINSERT INTO t DOCUMENTS ([{"_id":"two"}]);';
    const stmts = splitStatements(stripDotCommandLines(text));
    expect(stmts).toHaveLength(2);
    expect(stmts[1]).toContain("two");
  });

  it("dot-command lines are noted and skipped, rest executes", async () => {
    const { stripDotCommandLines } = await import("../../src/cli/groups/dql/batch.js");
    const out = stripDotCommandLines("SELECT 1;\n.exit\nSELECT 2;");
    expect(errSpy.mock.calls.flat().join(" ")).toContain("skipping REPL command");
    expect(out).not.toContain(".exit");
    expect(out).toContain("SELECT 2;");
  });
});

describe("validateOutPath (shared -o pre-validation)", () => {
  it("null for a good target; errors for directory target / missing parent", async () => {
    const { validateOutPath } = await import("../../src/cli/groups/dql/run.js");
    const dir = tmpDataDir("ditto-vout-");
    try {
      expect(validateOutPath(`${dir}/out.json`)).toBeNull();
      expect(validateOutPath(dir)).toContain("directory");
      expect(validateOutPath(`${dir}/nope/out.json`)).toContain("no such directory");
    } finally {
      rmrf(dir);
    }
  });
});

describe("batch dot-command stripping — string-literal awareness", () => {
  it("dot-command lines inside multi-line STRING LITERALS are data, not commands", async () => {
    const { stripDotCommandLines } = await import("../../src/cli/groups/dql/batch.js");
    const { splitStatements } = await import("../../src/query/split.js");
    const text = "SELECT 'foo\n.exit\nbar' AS txt FROM system:collections LIMIT 1;";
    const out = stripDotCommandLines(text);
    expect(out).toBe(text); // nothing stripped
    expect(errSpy.mock.calls.flat().join(" ")).not.toContain("skipping REPL command");
    expect(splitStatements(out)[0]).toContain("foo\n.exit\nbar");
  });

  it("preserves CRLF inside multi-line string literals byte-exactly", async () => {
    const { stripDotCommandLines } = await import("../../src/cli/groups/dql/batch.js");
    const text =
      "INSERT INTO t DOCUMENTS ({'_id':'c1','txt':'l1\r\nl2'});\r\n.exit\r\nSELECT * FROM t;";
    const out = stripDotCommandLines(text);
    expect(out).toContain("l1\r\nl2"); // untouched inside the literal
    expect(out).not.toContain(".exit");
    expect(out).toContain("\r\n"); // line endings preserved
  });

  it("handles CR-only line endings", async () => {
    const { stripDotCommandLines } = await import("../../src/cli/groups/dql/batch.js");
    const out = stripDotCommandLines("SELECT 1;\r.exit\rSELECT 2;");
    expect(out).not.toContain(".exit");
    expect(out).toContain("SELECT 2;");
  });

  it("dot-command lines AFTER a string closes are still stripped", async () => {
    const { stripDotCommandLines } = await import("../../src/cli/groups/dql/batch.js");
    const out = stripDotCommandLines("SELECT 'x';\n.exit\nSELECT 2;");
    expect(out).not.toContain(".exit");
    expect(out).toContain("SELECT 2;");
  });
});

describe("runStatement diagnostics (--time/--explain/--profile)", () => {
  const rows = [{ _id: "1", title: "Alien" }];

  it("--profile prefixes PROFILE onto bare SELECTs and renders the profile", async () => {
    const { executor, calls } = profileExecutor(rows);
    const r = await runStatement(executor, "SELECT * FROM movies WHERE rated = 'PG'", {
      ...baseOpts,
      format: "json",
      profile: true,
      stdoutIsTTY: true,
    });
    expect(calls[0]).toBe("PROFILE SELECT * FROM movies WHERE rated = 'PG'");
    expect(r.profile?.queryType).toBe("select");
    const out = outSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Execution Profile");
    expect(out).toContain("▲ HOT"); // filter has 90% of exec in the fake envelope
    // envelope row must not leak into the result rows
    expect(out).not.toContain("~request_profile");
  });

  it("--profile never double-prefixes a user-typed PROFILE", async () => {
    const { executor, calls } = profileExecutor(rows);
    await runStatement(executor, "PROFILE SELECT * FROM movies", {
      ...baseOpts,
      format: "json",
      profile: true,
    });
    expect(calls[0]).toBe("PROFILE SELECT * FROM movies");
  });

  it("--profile on non-SELECT runs without prefix and prints a note", async () => {
    const { executor, calls } = profileExecutor([]);
    const r = await runStatement(executor, "INSERT INTO movies DOCUMENTS ({'_id':'1'})", {
      ...baseOpts,
      profile: true,
    });
    expect(calls[0]).toBe("INSERT INTO movies DOCUMENTS ({'_id':'1'})");
    expect(errSpy.mock.calls.flat().join(" ")).toContain("only SELECT statements are profilable");
    expect(r.ok).toBe(true);
  });

  it("--explain runs the side-trip for SELECTs and renders the plan", async () => {
    const { executor, calls } = profileExecutor(rows);
    await runStatement(executor, "SELECT * FROM movies", {
      ...baseOpts,
      format: "json",
      explain: true,
      stdoutIsTTY: true,
    });
    expect(calls).toEqual(["SELECT * FROM movies", "EXPLAIN SELECT * FROM movies"]);
    expect(outSpy.mock.calls.flat().join("\n")).toContain("Query plan");
  });

  it("--explain never side-trips ADVISE (invalid syntax upstream)", async () => {
    const { executor, calls } = profileExecutor(rows);
    await runStatement(executor, "ADVISE SELECT * FROM movies", {
      ...baseOpts,
      format: "json",
      explain: true,
      profile: true,
    });
    expect(calls).toEqual(["ADVISE SELECT * FROM movies"]);
  });

  it("--time prints a footer; server times appear when a profile is present", async () => {
    const { executor } = profileExecutor(rows);
    await runStatement(executor, "SELECT * FROM movies", {
      ...baseOpts,
      format: "json",
      time: true,
    });
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Time: [\d.]+ ms/);

    errSpy.mockClear();
    const { executor: withProf } = profileExecutor(rows);
    await runStatement(withProf, "SELECT * FROM movies", {
      ...baseOpts,
      format: "json",
      time: true,
      profile: true,
    });
    const footer = errSpy.mock.calls.flat().join(" ");
    expect(footer).toContain("server: elapsed 1.67 ms");
    expect(footer).toContain("parse 46.21 µs");
  });

  it("piped mode keeps stdout pure: profile view goes to stderr, stdout stays JSON", async () => {
    const { executor } = profileExecutor(rows);
    const r = await runStatement(executor, "SELECT * FROM movies WHERE rated = 'PG'", {
      ...baseOpts,
      format: "json",
      profile: true,
      stdoutIsTTY: false,
    });
    expect(r.ok).toBe(true);
    const out = outSpy.mock.calls.flat().join("\n");
    expect(out).not.toContain("Execution Profile");
    expect(JSON.parse(out)).toEqual(rows);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("Execution Profile");
  });

  it("--time prints for mutations too", async () => {
    await runStatement(fakeExecutor([]), "INSERT INTO movies DOCUMENTS ({'_id':'1'})", {
      ...baseOpts,
      time: true,
    });
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Time: [\d.]+ ms/);
  });

  it("no-LIMIT warning does not fire when -o already exports everything", async () => {
    process.env.DITTO_CONFIG_DIR = tmpDataDir("ditto-state-");
    try {
      const dir = tmpDataDir("ditto-run-");
      const out = path.join(dir, "all.json");
      await runStatement(fakeExecutor([{ _id: "1" }]), "SELECT * FROM movies", {
        ...baseOpts,
        interactive: true,
        out,
      });
      expect(errSpy.mock.calls.flat().join("\n")).not.toContain("no LIMIT");
      rmrf(dir);
    } finally {
      rmrf(process.env.DITTO_CONFIG_DIR);
      delete process.env.DITTO_CONFIG_DIR;
    }
  });

  it("DITTO_QUIET=0/false does NOT silence notes (explicit values only)", async () => {
    const { executor } = profileExecutor([]);
    process.env.DITTO_QUIET = "0";
    try {
      await runStatement(executor, "INSERT INTO movies DOCUMENTS ({'_id':'1'})", {
        ...baseOpts,
        profile: true,
      });
      expect(errSpy.mock.calls.flat().join(" ")).toContain("only SELECT statements");
    } finally {
      delete process.env.DITTO_QUIET;
    }
  });

  it("--quiet suppresses dim notes (DITTO_QUIET)", async () => {
    const { executor } = profileExecutor([]);
    process.env.DITTO_QUIET = "1";
    try {
      await runStatement(executor, "INSERT INTO movies DOCUMENTS ({'_id':'1'})", {
        ...baseOpts,
        profile: true,
      });
      expect(errSpy.mock.calls.flat().join(" ")).not.toContain("only SELECT statements");
    } finally {
      delete process.env.DITTO_QUIET;
    }
  });

  it("-o to an unwritable path fails cleanly (ok:false, no stack trace)", async () => {
    const r = await runStatement(fakeExecutor([{ _id: "1" }]), "SELECT * FROM movies", {
      ...baseOpts,
      format: "json",
      out: "/nonexistent-dir-xyz/deep/out.json",
    });
    expect(r.ok).toBe(false);
    expect(errSpy.mock.calls.flat().join("\n")).toContain("Cannot write");
    expect(errSpy.mock.calls.flat().join("\n")).not.toContain("at ");
  });

  it("--explain on non-SELECT prints the note", async () => {
    await runStatement(fakeExecutor([]), "UPDATE movies SET x = 1", { ...baseOpts, explain: true });
    expect(errSpy.mock.calls.flat().join(" ")).toContain("only SELECT statements can be EXPLAINed");
  });

  it("-o file exports are uncapped by default; explicit --max-rows still caps", async () => {
    const dir = tmpDataDir("ditto-run-");
    try {
      const rows = Array.from({ length: 50 }, (_, i) => ({ n: i }));
      const out = path.join(dir, "all.json");
      const r = await runStatement(fakeExecutor(rows), "SELECT * FROM movies", {
        ...baseOpts,
        maxRows: 10, // console cap
        maxRowsExplicit: false,
        out,
      });
      expect(r.ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toHaveLength(50); // NOT capped at 10

      const out2 = path.join(dir, "capped.json");
      await runStatement(fakeExecutor(rows), "SELECT * FROM movies", {
        ...baseOpts,
        maxRows: 10,
        maxRowsExplicit: true, // user asked
        out: out2,
      });
      expect(JSON.parse(fs.readFileSync(out2, "utf8"))).toHaveLength(10);
      expect(outSpy.mock.calls.flat().join(" ")).toContain("first 10 of 50");
    } finally {
      rmrf(dir);
    }
  });

  it("-o expands a leading tilde in the output path", async () => {
    const home = tmpDataDir("ditto-home-");
    const hadHome = process.env.HOME;
    const hadUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on win32
    try {
      const r = await runStatement(fakeExecutor([{ _id: "1" }]), "SELECT * FROM movies", {
        ...baseOpts,
        out: "~/r6-out.json",
      });
      expect(r.ok).toBe(true);
      expect(fs.existsSync(path.join(home, "r6-out.json"))).toBe(true);
    } finally {
      rmrf(home);
      if (hadHome === undefined) delete process.env.HOME;
      else process.env.HOME = hadHome;
      if (hadUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = hadUserProfile;
    }
  });

  it("-o files never contain ANSI escapes, even with colors forced on", async () => {
    const prev = chalk.level;
    chalk.level = 2; // simulate a colored TTY
    try {
      const dir = tmpDataDir("ditto-run-");
      try {
        const out = path.join(dir, "out.txt");
        const r = await runStatement(
          fakeExecutor([{ _id: "1", title: "Alien" }]),
          "SELECT * FROM movies",
          {
            ...baseOpts,
            out,
          },
        );
        expect(r.ok).toBe(true);
        const content = fs.readFileSync(out, "utf8");
        expect(content).not.toContain("");
        expect(content).toContain("Alien");
      } finally {
        rmrf(dir);
      }
    } finally {
      chalk.level = prev;
    }
  });
});

describe("runStatement --advise", () => {
  const ADVICE_ROW = {
    advice: {
      statement: "SELECT * FROM movies WHERE rated = 'PG'",
      suggestedIndexes: [
        {
          collection: "movies",
          reason: "equality predicates on `rated`",
          statement:
            "CREATE INDEX IF NOT EXISTS adv_movies_rated ON default:`movies` (`rated` ASC)",
        },
      ],
    },
  };

  function adviseExecutor() {
    const calls: string[] = [];
    const executor: QueryExecutor = {
      execute: async (statement: string) => {
        calls.push(statement);
        if (statement.startsWith("ADVISE ")) {
          return { items: [{ value: ADVICE_ROW }] } as unknown as QueryResult;
        }
        return { items: [] } as unknown as QueryResult; // CREATE INDEX → OK
      },
    };
    return { executor, calls };
  }

  it("wraps SELECTs in ADVISE and renders the advice card", async () => {
    const { executor, calls } = adviseExecutor();
    const r = await runStatement(executor, "SELECT * FROM movies WHERE rated = 'PG'", {
      ...baseOpts,
      advise: true,
      stdoutIsTTY: true,
    });
    expect(calls[0]).toBe("ADVISE SELECT * FROM movies WHERE rated = 'PG'");
    expect(r.ok).toBe(true);
    const out = outSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Index advice");
    expect(out).toContain("adv_movies_rated");
  });

  it("renders advice for a user-typed ADVISE statement (no double-wrap)", async () => {
    const { executor, calls } = adviseExecutor();
    await runStatement(executor, "ADVISE SELECT * FROM movies", { ...baseOpts, stdoutIsTTY: true });
    expect(calls).toEqual(["ADVISE SELECT * FROM movies"]);
    expect(outSpy.mock.calls.flat().join("\n")).toContain("Index advice");
  });

  it("--advise takes precedence over --profile/--explain with a note", async () => {
    const { executor, calls } = adviseExecutor();
    await runStatement(executor, "SELECT * FROM movies", {
      ...baseOpts,
      advise: true,
      profile: true,
      explain: true,
    });
    expect(calls).toEqual(["ADVISE SELECT * FROM movies"]);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("takes precedence");
  });

  it("--advise on non-SELECT runs the statement plainly with a note", async () => {
    const { executor, calls } = adviseExecutor();
    const r = await runStatement(executor, "UPDATE movies SET rated = 'R'", {
      ...baseOpts,
      advise: true,
    });
    expect(calls).toEqual(["UPDATE movies SET rated = 'R'"]);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("applies to SELECT");
    expect(r.ok).toBe(true);
  });

  it("--apply executes suggestions after confirmation", async () => {
    const { executor, calls } = adviseExecutor();
    const r = await runStatement(executor, "SELECT * FROM movies WHERE rated = 'PG'", {
      ...baseOpts,
      advise: true,
      apply: true,
      stdoutIsTTY: true,
      confirm: async () => true,
    });
    expect(calls[1]).toBe(
      "CREATE INDEX IF NOT EXISTS adv_movies_rated ON default:`movies` (`rated` ASC)",
    );
    expect(r.ok).toBe(true);
    expect(outSpy.mock.calls.flat().join("\n")).toContain("✓ created");
  });

  it("--apply with -y skips the prompt entirely", async () => {
    const { executor, calls } = adviseExecutor();
    await runStatement(executor, "SELECT * FROM movies WHERE rated = 'PG'", {
      ...baseOpts,
      advise: true,
      apply: true,
      yes: true,
      stdoutIsTTY: true,
      // no confirm provided — would throw if prompted
      confirm: undefined,
    });
    expect(calls[1]).toContain("CREATE INDEX");
  });

  it("--apply declines skip the CREATE", async () => {
    const { executor, calls } = adviseExecutor();
    await runStatement(executor, "SELECT * FROM movies WHERE rated = 'PG'", {
      ...baseOpts,
      advise: true,
      apply: true,
      stdoutIsTTY: true,
      confirm: async () => false,
    });
    expect(calls).toHaveLength(1);
    expect(outSpy.mock.calls.flat().join("\n")).not.toContain("✓ created");
  });

  it("--apply marks failures", async () => {
    const calls: string[] = [];
    const executor: QueryExecutor = {
      execute: async (statement: string) => {
        calls.push(statement);
        if (statement.startsWith("ADVISE ")) {
          return { items: [{ value: ADVICE_ROW }] } as unknown as QueryResult;
        }
        throw new Error("duplicate index name");
      },
    };
    await runStatement(executor, "SELECT * FROM movies WHERE rated = 'PG'", {
      ...baseOpts,
      advise: true,
      apply: true,
      yes: true,
      stdoutIsTTY: true,
    });
    expect(outSpy.mock.calls.flat().join("\n")).toContain("✗ failed");
  });
});
