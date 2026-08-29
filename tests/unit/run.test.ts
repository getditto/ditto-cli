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
