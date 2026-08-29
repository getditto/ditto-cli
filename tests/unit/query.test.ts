import { describe, expect, it } from "vitest";
import { capRows, classify, extractRows } from "../../src/query/execute.js";

describe("classify", () => {
  it.each([
    ["SELECT * FROM movies", "select"],
    ["  select * from movies", "select"],
    ["-- a comment\nSELECT * FROM movies", "select"],
    ["/* block */ SELECT * FROM movies", "select"],
    ["EXPLAIN SELECT * FROM movies", "explain"],
    ["PROFILE SELECT * FROM movies", "profile"],
    ["ADVISE SELECT * FROM movies", "advise"],
    ["INSERT INTO movies DOCUMENTS ({})", "mutation"],
    ["UPDATE movies SET a = 1", "mutation"],
    ["EVICT FROM movies WHERE true", "mutation"],
    ["DELETE FROM movies WHERE true", "mutation"],
    ["TOMBSTONE FROM movies WHERE true", "mutation"],
    ["CREATE INDEX i ON movies (x)", "ddl"],
    ["DROP INDEX i ON movies", "ddl"],
    ["ALTER SYSTEM SET x = 1", "ddl"],
    ["SHOW collections", "other"],
    ["", "other"],
    ["   ", "other"],
    ["-- only a comment", "other"],
  ] as const)("classifies %j as %s", (statement, kind) => {
    expect(classify(statement)).toBe(kind);
  });
});

describe("extractRows", () => {
  it("maps plain item values", () => {
    const result = { items: [{ value: { a: 1 } }, { value: { a: 2 } }] };
    expect(extractRows(result as never)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("resolves zero-arg accessor values (SDK v5 shape)", () => {
    const result = { items: [{ value: () => ({ a: 1 }) }] };
    expect(extractRows(result as never)).toEqual([{ a: 1 }]);
  });

  it("handles empty / missing items", () => {
    expect(extractRows({ items: [] } as never)).toEqual([]);
    expect(extractRows({} as never)).toEqual([]);
  });

  it("tolerates null/undefined item values", () => {
    const result = { items: [{ value: null }, { value: undefined }] };
    expect(extractRows(result as never)).toEqual([{}, {}]);
  });
});

describe("capRows", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ n: i }));

  it("returns all rows when under the cap", () => {
    const r = capRows(rows, 10);
    expect(r.rows).toHaveLength(5);
    expect(r.truncated).toBe(false);
    expect(r.total).toBe(5);
  });

  it("truncates and reports the true total", () => {
    const r = capRows(rows, 2);
    expect(r.rows).toEqual([{ n: 0 }, { n: 1 }]);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(5);
  });

  it("cap equal to length is not truncated", () => {
    const r = capRows(rows, 5);
    expect(r.truncated).toBe(false);
  });
});
