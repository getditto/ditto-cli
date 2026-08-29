import { describe, expect, it } from "vitest";
import { ParamError, parseParams } from "../../src/query/params.js";

describe("parseParams", () => {
  it("returns undefined when nothing is provided", () => {
    expect(parseParams(undefined, undefined)).toBeUndefined();
  });

  it("parses -p pairs with JSON values", () => {
    expect(parseParams(["year=1994", "limit=10", "active=true"], undefined)).toEqual({
      year: 1994,
      limit: 10,
      active: true,
    });
  });

  it("falls back to bare strings", () => {
    expect(parseParams(["title=Alien"], undefined)).toEqual({ title: "Alien" });
  });

  it("handles values containing = signs", () => {
    expect(parseParams(["expr=a=b"], undefined)).toEqual({ expr: "a=b" });
  });

  it("parses --args JSON objects", () => {
    expect(parseParams(undefined, '{"year":1994,"title":"Alien"}')).toEqual({
      year: 1994,
      title: "Alien",
    });
  });

  it("-p overrides --args on conflict", () => {
    expect(parseParams(["year=2000"], '{"year":1994}')).toEqual({ year: 2000 });
  });

  it("rejects malformed -p pairs (usage, exit 2)", () => {
    expect(() => parseParams(["noequals"], undefined)).toThrow(ParamError);
    expect(() => parseParams(["=value"], undefined)).toThrow(ParamError);
  });

  it("rejects non-object --args (usage, exit 2)", () => {
    for (const bad of ["[1,2]", '"str"', "42", "not json"]) {
      expect(() => parseParams(undefined, bad)).toThrow(ParamError);
    }
  });
});
