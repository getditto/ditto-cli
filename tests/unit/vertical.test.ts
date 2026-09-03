import { describe, expect, it } from "vitest";
import { renderVertical } from "../../src/render/vertical.js";

describe("renderVertical", () => {
  it("renders empty rows", () => {
    expect(renderVertical([])).toBe("(no rows)");
  });

  it("renders one block per row with key │ value lines", () => {
    const out = renderVertical([
      { _id: "1", title: "Alien", year: 1979 },
      { _id: "2", title: "Blade Runner", year: 1982 },
    ]);
    expect(out).toContain("row 1");
    expect(out).toContain("row 2");
    expect(out).toContain("_id   │ 1");
    expect(out).toContain("title │ Alien");
    expect(out).toContain("year  │ 1979");
    expect(out).toMatch(/2 rows$/);
  });

  it("aligns keys to the widest key", () => {
    const out = renderVertical([{ a: 1, longkey: 2 }]);
    const lines = out.split("\n");
    expect(lines).toContain("a       │ 1");
    expect(lines).toContain("longkey │ 2");
  });

  it("never truncates long values (the point of vertical mode)", () => {
    const long = "x".repeat(500);
    const out = renderVertical([{ _id: "1", plot: long }]);
    expect(out).toContain(long);
  });

  it("renders nested objects as compact JSON and nulls as null", () => {
    const out = renderVertical([{ _id: "1", loc: { city: "Seattle" }, extra: null }]);
    expect(out).toContain('{"city":"Seattle"}');
    expect(out).toContain("extra │ null");
  });
});
