import { describe, expect, it, vi } from "vitest";
import { Recoverable } from "node:repl";
import type { QueryResult } from "@dittolive/ditto";
import { dotHelp, makeReplEval, StatementBuffer } from "../../src/cli/groups/dql/repl-core.js";
import type { QueryExecutor } from "../../src/ditto/session.js";

describe("StatementBuffer (REPL core)", () => {
  it("completes a single-line statement", () => {
    const buf = new StatementBuffer();
    const r = buf.feed("SELECT * FROM movies;");
    expect(r).toEqual({ complete: true, statement: "SELECT * FROM movies" });
  });

  it("buffers across lines until the semicolon arrives", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("SELECT *").complete).toBe(false);
    expect(buf.feed("FROM movies").complete).toBe(false);
    const r = buf.feed("WHERE year = 1994;");
    expect(r.complete).toBe(true);
    expect(r.statement).toBe("SELECT *\nFROM movies\nWHERE year = 1994");
  });

  it("does not complete on semicolons inside strings", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("SELECT * FROM movies WHERE title = 'a;b'").complete).toBe(false);
    expect(buf.feed(";").complete).toBe(true);
  });

  it("strips the trailing terminator", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("SELECT 1;   ").statement).toBe("SELECT 1");
  });

  it("clears after completion so the next statement starts fresh", () => {
    const buf = new StatementBuffer();
    buf.feed("SELECT 1;");
    expect(buf.feed("SELECT 2;").statement).toBe("SELECT 2");
  });

  it("stays incomplete on comment-only input", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("-- nothing;").complete).toBe(false);
  });

  it("reset discards buffered partial input", () => {
    const buf = new StatementBuffer();
    buf.feed("SELECT *");
    buf.reset();
    expect(buf.feed("FROM movies;").complete).toBe(true);
  });
});

describe("dotHelp", () => {
  it("documents every dot-command", () => {
    for (const cmd of [".help", ".collections", ".indexes", ".exit"]) {
      expect(dotHelp()).toContain(cmd);
    }
  });
});

describe("makeReplEval", () => {
  const executor: QueryExecutor = {
    execute: async () => ({ items: [{ value: { _id: "1" } }] }) as unknown as QueryResult,
  };

  it("signals Recoverable (continuation) for incomplete input", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const evalFn = makeReplEval(executor);
      const cb = vi.fn();
      evalFn("SELECT *\n", {}, "", cb);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]![0]).toBeInstanceOf(Recoverable);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("runs complete statements and reports timing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const evalFn = makeReplEval(executor);
      const cb = vi.fn();
      evalFn("SELECT * FROM movies;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
      const errOut = spy.mock.calls.flat().join(" ");
      expect(errOut).toMatch(/\(\d+\.\d ms\)/);
      expect(logSpy.mock.calls.flat().join(" ")).toContain("_id");
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("notes failure without throwing", async () => {
    const failing: QueryExecutor = {
      execute: async () => {
        throw new Error("bad query");
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const evalFn = makeReplEval(failing);
      const cb = vi.fn();
      evalFn("SELEC broken;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
      expect(spy.mock.calls.flat().join("\n")).toContain("statement failed");
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
