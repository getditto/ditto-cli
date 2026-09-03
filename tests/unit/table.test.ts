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

  describe("maxWidth (terminal fitting)", () => {
    it("fits the table within the given width, ellipsizing long cells", () => {
      const out = renderTable([{ _id: "1", plot: "a".repeat(100), title: "Alien" }], {
        maxWidth: 40,
      });
      for (const line of out.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
      expect(out).toContain("…");
      expect(out).not.toContain("a".repeat(100));
    });

    it("hard-caps cells at 60 chars even with a huge maxWidth", () => {
      const out = renderTable([{ _id: "1", plot: "b".repeat(500) }], { maxWidth: 10_000 });
      expect(out).toContain(`${"b".repeat(59)}…`);
      expect(out).not.toContain("b".repeat(61));
    });

    it("never truncates without maxWidth (files/pipes keep full fidelity)", () => {
      const out = renderTable([{ _id: "1", plot: "c".repeat(500) }]);
      expect(out).toContain("c".repeat(500));
    });

    it("keeps every line exactly border-width when fitted", () => {
      const out = renderTable(
        [
          { _id: "1", a: "x".repeat(80), b: "y".repeat(80) },
          { _id: "2", a: "short", b: "also short" },
        ],
        { maxWidth: 50 },
      );
      const lines = out.split("\n").filter((l) => l.startsWith("│") || l.startsWith("┌"));
      expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    });

    it("accepts defeat gracefully when there are too many columns to fit", () => {
      const row = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`col${i}`, i]));
      // Must not hang or crash; the table may exceed maxWidth at the floor.
      const out = renderTable([row], { maxWidth: 20 });
      expect(out).toContain("1 row");
    });

    it("ellipsizes headers too on very narrow terminals (regression: negative repeat crash)", () => {
      // maxWidth below the column floor: headers wider than the floor must shrink too.
      const out = renderTable([{ fullplot: "x".repeat(100), countries: "USA" }], {
        maxWidth: 12,
      });
      expect(out).toContain("fullp…");
      expect(out).toContain("1 row");
    });
  });

  describe("polish", () => {
    it("right-aligns numbers, left-aligns text", () => {
      const out = renderTable([
        { _id: "abc", n: 5 },
        { _id: "d", n: 12345 },
      ]);
      const lines = out.split("\n");
      const first = lines.find((l) => l.includes("abc"))!;
      // _id column is 3 wide ("abc" fills it); n column is 5 wide (12345):
      // the 5 pads left (right-aligned number).
      expect(first).toContain("│ abc │     5 │");
      const second = lines.find((l) => l.includes("12345"))!;
      expect(second).toContain("│ d   │ 12345 │"); // "d" pads right (left-aligned text)
    });
  });
});
