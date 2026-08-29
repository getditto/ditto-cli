import { describe, expect, it } from "vitest";
import { isCompleteStatement, splitStatements } from "../../src/query/split.js";

describe("splitStatements", () => {
  it("splits on semicolons", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("handles a single statement with no terminator", () => {
    expect(splitStatements("SELECT * FROM movies")).toEqual(["SELECT * FROM movies"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    expect(splitStatements("INSERT INTO movies DOCUMENTS ({'_id':'1','title':'Semi;colon'}); SELECT 1")).toEqual([
      "INSERT INTO movies DOCUMENTS ({'_id':'1','title':'Semi;colon'})",
      "SELECT 1",
    ]);
  });

  it("ignores semicolons inside double quotes and backticks", () => {
    expect(splitStatements(`SELECT * FROM "weird;name"; SELECT * FROM \`other;name\``)).toEqual([
      'SELECT * FROM "weird;name"',
      "SELECT * FROM `other;name`",
    ]);
  });

  it("handles SQL doubled-quote escapes", () => {
    expect(splitStatements("SELECT * FROM movies WHERE title = 'It''s; here'")).toEqual([
      "SELECT * FROM movies WHERE title = 'It''s; here'",
    ]);
  });

  it("strips -- line comments", () => {
    expect(splitStatements("-- leading comment\nSELECT 1; -- trailing\nSELECT 2")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
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
