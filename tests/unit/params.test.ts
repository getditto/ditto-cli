import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ParamError,
  parseParams,
  parsePositiveInt,
  resolveArgsSource,
} from "../../src/query/params.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

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
    expect(() => parseParams(["   =5"], undefined)).toThrow(ParamError); // whitespace-only name
  });

  it("rejects prototype-polluting names", () => {
    for (const bad of ["__proto__=1", "constructor=1", "prototype=1"]) {
      expect(() => parseParams([bad], undefined)).toThrow(/prototype pollution/);
    }
  });

  it("binds __proto__-adjacent but safe names fine", () => {
    expect(parseParams(["proto=1", "myConstructor=x"], undefined)).toMatchObject({
      proto: 1,
      myConstructor: "x",
    });
    expect(Object.keys(parseParams(["proto=1"], undefined)!)).toContain("proto");
  });

  it("rejects non-object --args (usage, exit 2)", () => {
    for (const bad of ["[1,2]", '"str"', "42", "not json"]) {
      expect(() => parseParams(undefined, bad)).toThrow(ParamError);
    }
  });
});

describe("resolveArgsSource", () => {
  const noStdin = async () => {
    throw new Error("stdin should not be read");
  };

  it("passes inline JSON through untouched", async () => {
    await expect(resolveArgsSource('{"year":1994}', noStdin)).resolves.toBe('{"year":1994}');
    await expect(resolveArgsSource(undefined, noStdin)).resolves.toBeUndefined();
  });

  it("'-' reads the JSON object from stdin", async () => {
    const readStdin = vi.fn(async () => '{"year":2001}');
    await expect(resolveArgsSource("-", readStdin)).resolves.toBe('{"year":2001}');
    expect(readStdin).toHaveBeenCalledOnce();
  });

  it("'@file' reads the JSON object from a file (tilde-safe)", async () => {
    const dir = tmpDataDir("args-file-");
    try {
      const file = path.join(dir, "params.json");
      fs.writeFileSync(file, '{"id":"abc"}', "utf8");
      await expect(resolveArgsSource(`@${file}`, noStdin)).resolves.toBe('{"id":"abc"}');
    } finally {
      rmrf(dir);
    }
  });

  it("rejects a bare '@' and unreadable files (usage, exit 2)", async () => {
    await expect(resolveArgsSource("@", noStdin)).rejects.toThrow(ParamError);
    await expect(resolveArgsSource("@/no/such/file.json", noStdin)).rejects.toThrow(/cannot read/);
  });

  it("composes with parseParams: stdin JSON becomes bound params", async () => {
    const json = await resolveArgsSource("-", async () => '{"year":2001}');
    expect(parseParams(undefined, json)).toEqual({ year: 2001 });
  });

  it("non-object JSON from stdin fails at parseParams with a clear error", async () => {
    const json = await resolveArgsSource("-", async () => "[1,2]");
    expect(() => parseParams(undefined, json)).toThrow(ParamError);
  });
});

describe("parsePositiveInt", () => {
  it("returns the fallback when undefined", () => {
    expect(parsePositiveInt(undefined, "--docs", 42)).toBe(42);
  });

  it("parses valid positive integers", () => {
    expect(parsePositiveInt("5000", "--docs", 1)).toBe(5000);
  });

  it("rejects garbage, floats, zero, negatives", () => {
    for (const bad of ["abc", "1.5", "0", "-3", ""]) {
      expect(() => parsePositiveInt(bad, "--docs", 1)).toThrow(ParamError);
    }
  });
});
