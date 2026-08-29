import { describe, expect, it } from "vitest";
import { formatForOutFile, renderRows, resolveFormat } from "../../src/render/output.js";

describe("resolveFormat", () => {
  it("honors an explicit valid flag", () => {
    expect(resolveFormat("json", true)).toBe("json");
    expect(resolveFormat("csv", false)).toBe("csv");
  });

  it("falls back to table on TTY, json when piped", () => {
    expect(resolveFormat(undefined, true)).toBe("table");
    expect(resolveFormat(undefined, false)).toBe("json");
  });

  it("ignores unknown flag values", () => {
    expect(resolveFormat("yaml", true)).toBe("table");
    expect(resolveFormat("yaml", false)).toBe("json");
  });
});

describe("formatForOutFile", () => {
  it("infers from extension", () => {
    expect(formatForOutFile("a.json")).toBe("json");
    expect(formatForOutFile("a.CSV")).toBe("csv");
    expect(formatForOutFile("a.txt")).toBe("table");
    expect(formatForOutFile("noext")).toBe("table");
  });

  it("explicit format wins over extension", () => {
    expect(formatForOutFile("a.json", "csv")).toBe("csv");
  });
});

describe("renderRows dispatch", () => {
  const rows = [{ _id: "1", v: 2 }];
  it("dispatches to the right renderer", () => {
    expect(renderRows(rows, "json")).toBe(JSON.stringify(rows, null, 2));
    expect(renderRows(rows, "csv")).toBe("_id,v\n1,2");
    expect(renderRows(rows, "table")).toContain("┌");
  });
});
