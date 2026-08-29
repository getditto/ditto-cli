import { describe, expect, it } from "vitest";
import { renderCsv } from "../../src/render/csv.js";

describe("renderCsv", () => {
  it("is empty for no rows", () => {
    expect(renderCsv([])).toBe("");
  });

  it("renders header + rows with _id first", () => {
    const out = renderCsv([
      { title: "Alien", _id: "1", year: 1979 },
      { _id: "2", title: "Blade Runner", year: 1982 },
    ]);
    expect(out).toBe("_id,title,year\n1,Alien,1979\n2,Blade Runner,1982");
  });

  it("quotes commas, quotes, and newlines", () => {
    const out = renderCsv([{ _id: "1", note: 'has, comma "and" quote\nand newline' }]);
    expect(out).toBe('_id,note\n1,"has, comma ""and"" quote\nand newline"');
  });

  it("serializes nested values as JSON (quoted)", () => {
    const out = renderCsv([{ _id: "1", location: { city: "Seattle" } }]);
    expect(out).toBe('_id,location\n1,"{""city"":""Seattle""}"');
  });

  it("renders null and undefined distinctly", () => {
    const out = renderCsv([{ _id: "1", a: null, b: undefined }]);
    expect(out).toBe("_id,a,b\n1,null,");
  });
});
