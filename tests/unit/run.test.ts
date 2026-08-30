import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { QueryResult } from "@dittolive/ditto";
import { runStatement, type RunOptions } from "../../src/cli/groups/dql/run.js";
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
        { "#operator": "scan", collection: "movies", "#stats": { documentsOut: 2, phaseTimes: { exec: 100_000 } }, children: [] },
        { "#operator": "filter", condition: "rated = 'PG'", "#stats": { documentsIn: 2, documentsOut: 2, phaseTimes: { exec: 900_000 } }, children: [] },
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
        return { items: [{ value: { plan: { operator: "sequence", children: [] } } }] } as unknown as QueryResult;
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
    const r = await runStatement(fakeExecutor([{ _id: "1", title: "Alien" }]), "SELECT * FROM movies", {
      ...baseOpts,
      format: "json",
    });
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
    expect(outSpy).toHaveBeenCalledWith("OK");
  });

  it("selects with zero rows render as a result, not OK", async () => {
    const r = await runStatement(fakeExecutor([]), "SELECT * FROM movies", { ...baseOpts, format: "table" });
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
      process.env.DITTO_CONFIG_DIR = undefined;
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
      process.env.DITTO_CONFIG_DIR = undefined;
    }
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
    await runStatement(executor, "PROFILE SELECT * FROM movies", { ...baseOpts, format: "json", profile: true });
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
    await runStatement(executor, "SELECT * FROM movies", { ...baseOpts, format: "json", explain: true });
    expect(calls).toEqual(["SELECT * FROM movies", "EXPLAIN SELECT * FROM movies"]);
    expect(outSpy.mock.calls.flat().join("\n")).toContain("Query plan");
  });

  it("--explain never side-trips ADVISE (invalid syntax upstream)", async () => {
    const { executor, calls } = profileExecutor(rows);
    await runStatement(executor, "ADVISE SELECT * FROM movies", { ...baseOpts, format: "json", explain: true, profile: true });
    expect(calls).toEqual(["ADVISE SELECT * FROM movies"]);
  });

  it("--time prints a footer; server times appear when a profile is present", async () => {
    const { executor } = profileExecutor(rows);
    await runStatement(executor, "SELECT * FROM movies", { ...baseOpts, format: "json", time: true });
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Time: [\d.]+ ms/);

    errSpy.mockClear();
    const { executor: withProf } = profileExecutor(rows);
    await runStatement(withProf, "SELECT * FROM movies", { ...baseOpts, format: "json", time: true, profile: true });
    const footer = errSpy.mock.calls.flat().join(" ");
    expect(footer).toContain("server: elapsed 1.67 ms");
    expect(footer).toContain("parse 46.21 µs");
  });
});
