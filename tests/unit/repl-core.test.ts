import { Recoverable } from "node:repl";
import type { QueryResult } from "@dittolive/ditto";
import { describe, expect, it, vi } from "vitest";
import { dotHelp, makeReplEval, StatementBuffer } from "../../src/cli/groups/dql/repl-core.js";
import type { QueryExecutor } from "../../src/ditto/session.js";

describe("StatementBuffer (REPL core)", () => {
  it("completes a single-line statement", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("SELECT * FROM movies;")).toEqual({
      statements: ["SELECT * FROM movies"],
      pending: false,
      rest: "",
    });
  });

  it("buffers across lines until the semicolon arrives", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("SELECT *")).toEqual({ statements: [], pending: true, rest: "SELECT *" });
    expect(buf.feed("FROM movies")).toMatchObject({ pending: true });
    const r = buf.feed("WHERE year = 1994;");
    expect(r).toMatchObject({
      statements: ["SELECT *\nFROM movies\nWHERE year = 1994"],
      pending: false,
    });
  });

  it("drains multiple statements pasted on one line", () => {
    const buf = new StatementBuffer();
    const r = buf.feed("SELECT 1; SELECT 2;");
    expect(r.statements).toEqual(["SELECT 1", "SELECT 2"]);
    expect(r.pending).toBe(false);
  });

  it("keeps a partial tail buffered after draining complete statements", () => {
    const buf = new StatementBuffer();
    const r = buf.feed("SELECT 1; SELECT * FROM movies WHERE");
    expect(r).toMatchObject({ statements: ["SELECT 1"], pending: true });
    expect(buf.feed("year = 1994;").statements).toEqual([
      "SELECT * FROM movies WHERE\nyear = 1994",
    ]);
  });

  it("a complete statement followed by a trailing comment completes and discards the comment", () => {
    const buf = new StatementBuffer();
    const r = buf.feed("SELECT 1; -- done");
    expect(r.statements).toEqual(["SELECT 1"]);
    expect(r.pending).toBe(false);
  });

  it("does not complete on semicolons inside strings", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("SELECT * FROM movies WHERE title = 'a;b'").pending).toBe(true);
    expect(buf.feed(";")).toMatchObject({
      statements: ["SELECT * FROM movies WHERE title = 'a;b'"],
    });
  });

  it("comment-only input completes with nothing to run", () => {
    const buf = new StatementBuffer();
    expect(buf.feed("-- nothing here")).toMatchObject({ statements: [], pending: false });
  });

  it("reset discards buffered partial input", () => {
    const buf = new StatementBuffer();
    buf.feed("SELECT *");
    buf.reset();
    expect(buf.feed("FROM movies;")).toMatchObject({ statements: ["FROM movies"] });
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
      const evalFn = makeReplEval(executor).eval;
      const cb = vi.fn();
      evalFn("SELECT *\n", {}, "", cb);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]![0]).toBeInstanceOf(Recoverable);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("comment-only input returns to the prompt without Recoverable", () => {
    const evalFn = makeReplEval(executor).eval;
    const cb = vi.fn();
    evalFn("-- just a note\n", {}, "", cb);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("runs complete statements and reports timing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const evalFn = makeReplEval(executor).eval;
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

  it("runs pasted multi-statement lines in order", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const recording: QueryExecutor = {
        execute: async (s: string) => {
          calls.push(s);
          return { items: [] } as unknown as QueryResult;
        },
      };
      const evalFn = makeReplEval(recording).eval;
      const cb = vi.fn();
      evalFn("SELECT * FROM movies; SELECT * FROM stores;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
      expect(calls).toEqual(["SELECT * FROM movies", "SELECT * FROM stores"]);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("passes unexpected failures to the callback as errors (not results)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const failing: QueryExecutor = {
        execute: async () => {
          throw new Error("bad query");
        },
      };
      const evalFn = makeReplEval(failing);
      const cb = vi.fn();
      evalFn.eval("SELEC broken;\n", {}, "", cb);
      // runStatement catches query errors itself, so cb(null) + failure note
      await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
      expect(spy.mock.calls.flat().join("\n")).toContain("statement failed");
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("multi-line input: node:repl RE-SENDS accumulated input after Recoverable (regression: double-buffering)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const recording: QueryExecutor = {
        execute: async (s: string) => {
          calls.push(s);
          return { items: [] } as unknown as QueryResult;
        },
      };
      const { eval: evalFn, reset } = makeReplEval(recording);
      const cb = vi.fn();

      // Line 1: incomplete → Recoverable; node:repl keeps accumulating
      evalFn("SELECT *\n", {}, "", cb);
      expect(cb.mock.calls[0]![0]).toBeInstanceOf(Recoverable);

      // Line 2: node:repl re-sends THE WHOLE accumulation (verified behavior)
      evalFn("SELECT *\nFROM movies;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      expect(calls).toEqual(["SELECT *\nFROM movies"]); // not "SELECT *\nSELECT *\nFROM movies"

      // .break mid-statement, then a fresh statement (must not be poisoned)
      evalFn("UPDATE movies\n", {}, "", cb);
      expect(cb.mock.calls.at(-1)![0]).toBeInstanceOf(Recoverable);
      reset(); // user hits .break
      evalFn("SELECT 1;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      expect(calls[1]).toBe("SELECT 1"); // not "UPDATE movies\nSELECT 1"
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("post-.exit input never executes (closed flag)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const recording: QueryExecutor = {
        execute: async (s: string) => {
          calls.push(s);
          return { items: [] } as unknown as QueryResult;
        },
      };
      const exited = vi.fn();
      const { eval: evalFn } = makeReplEval(recording, { onExit: exited });
      const cb = vi.fn();

      evalFn("SELECT 1;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      evalFn("SELECT 2;\n.exit\n", {}, "", cb); // .exit at a fresh line inside cmd
      await vi.waitFor(() => expect(exited).toHaveBeenCalled());
      evalFn("SELECT 3;\n", {}, "", cb); // after exit — must no-op
      await new Promise((r) => setImmediate(r));
      expect(calls).toEqual(["SELECT 1"]); // 2 and 3 never ran
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("a .exit LINE inside a string literal is data, not a command", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const recording: QueryExecutor = {
        execute: async (s: string) => {
          calls.push(s);
          return { items: [] } as unknown as QueryResult;
        },
      };
      const { eval: evalFn } = makeReplEval(recording);
      const cb = vi.fn();
      // multi-line statement whose second line is '.exit' INSIDE a string
      evalFn("SELECT * FROM movies WHERE plot = 'abc\n.exit\n';\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      expect(calls).toEqual(["SELECT * FROM movies WHERE plot = 'abc\n.exit\n'"]);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("--time in the REPL prints one footer (not the per-statement note too)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const executor: QueryExecutor = {
        execute: async () => ({ items: [] }) as unknown as QueryResult,
      };
      const { eval: evalFn } = makeReplEval(executor, {
        runOpts: { maxRows: 100, maxRowsExplicit: true, time: true },
      });
      const cb = vi.fn();
      evalFn("SELECT 1;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      const err = spy.mock.calls.flat().join("\n");
      expect(err).toContain("Time:"); // run.ts footer
      expect(err).not.toMatch(/\(\d+\.\d ms\)/); // no duplicate per-statement note
      expect(err).not.toContain("no LIMIT"); // REPL always suppresses it
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("dot-commands at a continuation are intercepted, not fed into the statement", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const recording: QueryExecutor = {
        execute: async (s: string) => {
          calls.push(s);
          return { items: [] } as unknown as QueryResult;
        },
      };
      const { eval: evalFn } = makeReplEval(recording);
      const cb = vi.fn();
      evalFn("SELECT *\n", {}, "", cb);
      expect(cb.mock.calls.at(-1)![0]).toBeInstanceOf(Recoverable);
      evalFn("SELECT *\n.break\n", {}, "", cb); // .break at continuation
      expect(cb.mock.calls.at(-1)![0]).toBeNull();
      evalFn("SELECT 1;\n", {}, "", cb); // fresh statement is clean
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      expect(calls).toEqual(["SELECT 1"]);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("a drain with a non-blank tail reports and drops it (lockstep with node:repl)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const recording: QueryExecutor = {
        execute: async (s: string) => {
          calls.push(s);
          return { items: [] } as unknown as QueryResult;
        },
      };
      const { eval: evalFn } = makeReplEval(recording);
      const cb = vi.fn();
      evalFn("SELECT 1; SELECT name FROM\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      expect(calls).toEqual(["SELECT 1"]);
      expect(spy.mock.calls.flat().join("\n")).toContain("discarding incomplete trailing text");
      // next line starts fresh — no stale tail
      evalFn("SELECT 2;\n", {}, "", cb);
      await vi.waitFor(() => expect(cb).toHaveBeenLastCalledWith(null));
      expect(calls).toEqual(["SELECT 1", "SELECT 2"]);
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
