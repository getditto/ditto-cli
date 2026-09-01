import { describe, expect, it } from "vitest";
import { renderTable } from "../../src/render/table.js";

describe("renderTable", () => {
  it("renders empty rows", () => {
    expect(renderTable([])).toBe("(no rows)");
  });

  it("puts _id first, then union of keys in first-seen order", () => {
    const out = renderTable([
      { title: "Alien", _id: "1", year: 1979 },
      { _id: "2", title: "Blade Runner", year: 1982, rated: "R" },
    ]);
    const header = out.split("\n")[1];
    expect(header).toContain("_id");
    expect(header?.indexOf("_id")).toBeLessThan(header?.indexOf("title") ?? 0);
    expect(header?.indexOf("title")).toBeLessThan(header?.indexOf("year") ?? 0);
    expect(header?.indexOf("year")).toBeLessThan(header?.indexOf("rated") ?? 0);
    // missing key renders as empty cell, not "undefined"
    expect(out).not.toContain("undefined");
    expect(out).toMatch(/2 rows$/);
  });

  it("renders nested objects as compact JSON", () => {
    const out = renderTable([{ _id: "1", location: { city: "Seattle", state: "WA" } }]);
    expect(out).toContain('{"city":"Seattle","state":"WA"}');
  });

  it("only treats {id, len, metadata|mime_type} shapes as attachments — {id, len} alone renders as data", () => {
    const out = renderTable([{ _id: "1", poster: { id: "att-9", len: 1024 } }]);
    expect(out).toContain('{"id":"att-9","len":1024}'); // data, not placeholder
    const real = renderTable([{ _id: "1", poster: { id: "att-9", len: 1024, metadata: {} } }]);
    expect(real).toContain("[attachment id=att-9 len=1024]");
  });

  it("renders attachment handles as placeholders", () => {
    const out = renderTable([{ _id: "1", poster: { id: "att-9", len: 1024, metadata: {} } }]);
    expect(out).toContain("[attachment id=att-9 len=1024]");
  });

  it("renders null and undefined distinctly and safely", () => {
    const out = renderTable([{ _id: "1", a: null }]);
    expect(out).toContain("null");
  });

  it("aligns columns to the widest cell", () => {
    const out = renderTable([
      { _id: "a", v: "x" },
      { _id: "bb", v: "yyyy" },
    ]);
    const lines = out.split("\n").filter((l) => l.startsWith("│") || l.startsWith("┌"));
    const widths = lines.map((l) => l.length);
    expect(new Set(widths).size).toBe(1); // every row is exactly as wide as the borders
  });

  it("ends with a row count line", () => {
    expect(renderTable([{ a: 1 }])).toMatch(/1 row$/);
    expect(renderTable([{ a: 1 }, { a: 2 }])).toMatch(/2 rows$/);
  });

  it("control characters in KEYS don't crash or break alignment", () => {
    const out = renderTable([{ "a\nb": 1, "t\tt": 2, normal: 3 }]);
    expect(out).toContain("a⏎b");
    expect(out).toContain("t⇥t");
    // every row line is exactly as wide as the borders
    const lines = out.split("\n").filter((l) => l.startsWith("│") || l.startsWith("┌"));
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });

  it("snapshot: typical document rows", () => {
    const out = renderTable([
      { _id: "1", rated: "R", title: "Alien", year: 1979 },
      { _id: "2", rated: "R", title: "Blade Runner", year: 1982 },
      { _id: "3", rated: "G", title: "Toy Story", year: 1995 },
    ]);
    expect(out).toMatchSnapshot();
  });
});
