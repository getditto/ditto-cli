import { describe, expect, it } from "vitest";
import {
  FormatError,
  formatForOutFile,
  renderRows,
  resolveFormat,
} from "../../src/render/output.js";

describe("resolveFormat", () => {
  it("honors an explicit valid flag", () => {
    expect(resolveFormat("json", true)).toBe("json");
    expect(resolveFormat("csv", false)).toBe("csv");
    expect(resolveFormat("markdown", true)).toBe("markdown");
    expect(resolveFormat("html", true)).toBe("html");
    expect(resolveFormat("vertical", true)).toBe("vertical");
  });

  it("falls back to table on TTY, json when piped", () => {
    expect(resolveFormat(undefined, true)).toBe("table");
    expect(resolveFormat(undefined, false)).toBe("json");
  });

  it("rejects unknown flag values (usage error)", () => {
    expect(() => resolveFormat("yaml", true)).toThrow(FormatError);
    expect(() => resolveFormat("yaml", false)).toThrow(FormatError);
    expect(() => resolveFormat("yaml", true)).toThrow(/table, json, csv, markdown, html, vertical/);
  });
});

describe("formatForOutFile", () => {
  it("infers from extension", () => {
    expect(formatForOutFile("a.json")).toBe("json");
    expect(formatForOutFile("a.CSV")).toBe("csv");
    expect(formatForOutFile("a.md")).toBe("markdown");
    expect(formatForOutFile("a.markdown")).toBe("markdown");
    expect(formatForOutFile("a.html")).toBe("html");
    expect(formatForOutFile("a.HTM")).toBe("html");
    expect(formatForOutFile("a.txt")).toBe("table");
    expect(formatForOutFile("noext")).toBe("table");
  });

  it("explicit format wins over extension; bogus explicit throws", () => {
    expect(formatForOutFile("a.json", "csv")).toBe("csv");
    expect(() => formatForOutFile("a.json", "yaml")).toThrow(FormatError);
  });
});

describe("renderRows dispatch", () => {
  const rows = [{ _id: "1", v: 2 }];
  it("dispatches to the right renderer", () => {
    expect(renderRows(rows, "json")).toBe(JSON.stringify(rows, null, 2));
    expect(renderRows(rows, "csv")).toBe("_id,v\n1,2");
    expect(renderRows(rows, "table")).toContain("┌");
    expect(renderRows(rows, "markdown")).toContain("| --- |");
    expect(renderRows(rows, "html")).toContain("<table>");
    expect(renderRows(rows, "vertical")).toContain("row 1");
  });

  it("passes maxWidth through to the table renderer", () => {
    const wide = [{ _id: "1", v: "x".repeat(200) }];
    const fitted = renderRows(wide, "table", { maxWidth: 40 });
    for (const line of fitted.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    // Without maxWidth the table keeps full fidelity.
    expect(renderRows(wide, "table")).toContain("x".repeat(200));
  });
});
