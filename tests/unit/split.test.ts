import { describe, expect, it } from "vitest";
import {
  endsInsideStringLiteral,
  hasLimitClause,
  isBlankOrComments,
  isCompleteStatement,
  splitComplete,
  splitStatements,
  stripLiteralsAndComments,
} from "../../src/query/split.js";

describe("splitStatements", () => {
  it("splits on semicolons", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("handles a single statement with no terminator", () => {
    expect(splitStatements("SELECT * FROM movies")).toEqual(["SELECT * FROM movies"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    expect(
      splitStatements("INSERT INTO movies DOCUMENTS ({'_id':'1','title':'Semi;colon'}); SELECT 1"),
    ).toEqual(["INSERT INTO movies DOCUMENTS ({'_id':'1','title':'Semi;colon'})", "SELECT 1"]);
  });

  it("ignores semicolons inside double quotes and backticks", () => {
    expect(splitStatements(`SELECT * FROM "weird;name"; SELECT * FROM \`other;name\``)).toEqual([
      'SELECT * FROM "weird;name"',
      "SELECT * FROM `other;name`",
    ]);
  });

  it("handles DQL backslash-escaped quotes (\\' — the only valid escape in DQL)", () => {
    // DQL rejects SQL doubled quotes ('') and accepts \' — the lexer must match.
    expect(splitStatements("SELECT * FROM movies WHERE plot = 'it\\'s'; SELECT 1")).toEqual([
      "SELECT * FROM movies WHERE plot = 'it\\'s'",
      "SELECT 1",
    ]);
  });

  it("trailing semicolon is seen after a backslash-escaped quote", () => {
    const r = splitComplete("SELECT * FROM movies WHERE plot = 'it\\'s' LIMIT 1;");
    expect(r.statements).toEqual(["SELECT * FROM movies WHERE plot = 'it\\'s' LIMIT 1"]);
    expect(r.rest).toBe("");
  });

  it("handles SQL doubled-quote input without crashing (invalid DQL — the SDK will reject it)", () => {
    // '' is not valid DQL; the lexer treats each quote as open/close. The
    // statement splits at the top-level ';' and the SDK reports the error.
    const parts = splitStatements("SELECT * FROM movies WHERE title = 'It''s; here'");
    expect(parts.length).toBeGreaterThan(0);
  });

  it("strips -- line comments", () => {
    expect(splitStatements("-- leading comment\nSELECT 1; -- trailing\nSELECT 2")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("unterminated /* block comment keeps the text (SDK reports the syntax error — nothing swallowed)", () => {
    const parts = splitStatements("SELECT 1;\n/* dangling\nINSERT INTO t DOCUMENTS ({'_id':'1'});");
    // the dangling comment text survives as part of the second statement
    expect(parts.length).toBe(2);
    expect(parts[1]).toContain("/* dangling");
    expect(parts[1]).toContain("INSERT INTO t");
  });

  it("strips /* */ block comments, even with semicolons inside", () => {
    expect(splitStatements("/* a; b; c */ SELECT 1; /* tail */")).toEqual(["SELECT 1"]);
  });

  it("drops empty statements from stray semicolons", () => {
    expect(splitStatements(";;SELECT 1;; ;")).toEqual(["SELECT 1"]);
  });

  it("returns [] for empty / comment-only input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("  \n -- nothing here\n /* nor here */ ")).toEqual([]);
  });

  it("preserves newlines inside statements", () => {
    const out = splitStatements("SELECT *\nFROM movies\nWHERE year = 1994;");
    expect(out).toEqual(["SELECT *\nFROM movies\nWHERE year = 1994"]);
  });
});

describe("isCompleteStatement", () => {
  it("requires a trailing semicolon", () => {
    expect(isCompleteStatement("SELECT 1")).toBe(false);
    expect(isCompleteStatement("SELECT 1;")).toBe(true);
  });

  it("is false for comment-only buffers", () => {
    expect(isCompleteStatement("-- nothing;")).toBe(false);
  });

  it("treats semicolons in strings as incomplete", () => {
    expect(isCompleteStatement("SELECT * FROM movies WHERE title = 'a;b'")).toBe(false);
  });
});

describe("splitComplete", () => {
  it("returns complete statements plus the raw rest", () => {
    const r = splitComplete("SELECT 1; SELECT 2; SELECT * FROM x WHERE");
    expect(r.statements).toEqual(["SELECT 1", "SELECT 2"]);
    expect(r.rest).toBe(" SELECT * FROM x WHERE");
  });

  it("keeps trailing comments in rest", () => {
    const r = splitComplete("SELECT 1; -- done");
    expect(r.statements).toEqual(["SELECT 1"]);
    expect(r.rest).toContain("-- done");
  });

  it("no terminator → all rest", () => {
    const r = splitComplete("SELECT 1");
    expect(r.statements).toEqual([]);
    expect(r.rest).toBe("SELECT 1");
  });
});

describe("stripLiteralsAndComments / hasLimitClause", () => {
  it("removes string contents and comments", () => {
    expect(stripLiteralsAndComments("SELECT * FROM m WHERE t = 'limit 5' -- limit 9")).toBe(
      "SELECT * FROM m WHERE t = '' ",
    );
  });

  it("hasLimitClause is not fooled by strings or comments", () => {
    expect(hasLimitClause("SELECT * FROM movies LIMIT 5")).toBe(true);
    expect(hasLimitClause("SELECT * FROM movies LIMIT :n")).toBe(true); // bound param counts
    expect(hasLimitClause("SELECT * FROM movies WHERE title = 'limit 5'")).toBe(false);
    expect(hasLimitClause("SELECT * FROM movies WHERE title = 'it\\' limit 5'")).toBe(false);
    expect(hasLimitClause("SELECT * FROM movies -- LIMIT 5")).toBe(false);
    expect(hasLimitClause("SELECT * FROM movies /* LIMIT 5 */ WHERE true")).toBe(false);
  });
});

describe("endsInsideStringLiteral (DQL backslash-aware)", () => {
  it("detects unterminated strings", () => {
    expect(endsInsideStringLiteral("SELECT * FROM movies WHERE plot = 'abc")).toBe(true);
    expect(endsInsideStringLiteral("SELECT * FROM movies WHERE plot = 'abc\n.exit")).toBe(true);
  });
  it("closed strings are not inside", () => {
    expect(endsInsideStringLiteral("SELECT * FROM movies WHERE plot = 'abc'")).toBe(false);
    expect(endsInsideStringLiteral("SELECT 1; -- done")).toBe(false);
  });
  it("backslash-escaped quotes don't close the string", () => {
    // String.raw keeps the backslash literal: content is ...it\'
    expect(endsInsideStringLiteral(String.raw`SELECT * FROM t WHERE v = 'it\'`)).toBe(true);
    expect(endsInsideStringLiteral(String.raw`SELECT * FROM t WHERE v = 'it\''`)).toBe(false);
  });
  it("comments don't confuse it", () => {
    expect(endsInsideStringLiteral("SELECT 1 -- 'never opened")).toBe(false);
    expect(endsInsideStringLiteral("SELECT 1 /* 'never opened */")).toBe(false);
  });
});

describe("isBlankOrComments", () => {
  it("detects blank/comment-only text", () => {
    expect(isBlankOrComments("")).toBe(true);
    expect(isBlankOrComments("  -- note\n/* more */ ")).toBe(true);
    expect(isBlankOrComments("SELECT 1")).toBe(false);
  });
});
