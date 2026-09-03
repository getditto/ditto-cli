import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/render/markdown.js";

describe("renderMarkdown", () => {
  it("renders empty rows", () => {
    expect(renderMarkdown([])).toBe("(no rows)");
  });

  it("renders a GFM table with _id first and a separator row", () => {
    const out = renderMarkdown([
      { title: "Alien", _id: "1", year: 1979 },
      { _id: "2", title: "Blade Runner", year: 1982, rated: "R" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("| _id | title | year | rated |");
    expect(lines[1]).toBe("| --- | --- | --- | --- |");
    expect(lines[2]).toBe("| 1 | Alien | 1979 |  |");
    expect(lines[3]).toBe("| 2 | Blade Runner | 1982 | R |");
  });

  it("escapes pipes and converts newlines to <br>", () => {
    const out = renderMarkdown([{ _id: "1", note: "a|b\nc" }]);
    expect(out).toContain("a\\|b<br>c");
  });

  it("renders nested objects as compact JSON", () => {
    const out = renderMarkdown([{ _id: "1", loc: { city: "Seattle" } }]);
    expect(out).toContain('{"city":"Seattle"}');
  });

  it("renders attachment handles as placeholders", () => {
    const out = renderMarkdown([{ _id: "1", poster: { id: "att-9", len: 5, metadata: {} } }]);
    expect(out).toContain("[attachment id=att-9 len=5]");
  });

  it("renders null and undefined distinctly", () => {
    const out = renderMarkdown([{ _id: "1", a: null, b: undefined }]);
    const cells = out.split("\n")[2]!;
    expect(cells).toContain("null");
    expect(cells).toMatch(/\| 1 \| null \| +\|/);
  });
});
