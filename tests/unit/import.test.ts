import type { QueryResult } from "@dittolive/ditto";
import { describe, expect, it, vi } from "vitest";
import {
  importDocuments,
  isValidCollectionName,
  parseImportFile,
} from "../../src/cli/groups/dql/import.js";
import type { QueryExecutor } from "../../src/ditto/session.js";

describe("parseImportFile", () => {
  it("parses a JSON array of objects (the standard format)", () => {
    const docs = parseImportFile('[{"_id":"a","v":1},{"_id":"b","nested":{"x":2}}]');
    expect(docs).toEqual([
      { _id: "a", v: 1 },
      { _id: "b", nested: { x: 2 } },
    ]);
  });

  it("accepts an empty array", () => {
    expect(parseImportFile("[]")).toEqual([]);
  });

  it("parses NDJSON (one object per line, blank lines skipped)", () => {
    const docs = parseImportFile('{"_id":"a"}\n\n{"_id":"b","v":2}\n');
    expect(docs).toEqual([{ _id: "a" }, { _id: "b", v: 2 }]);
  });

  it("rejects an empty file", () => {
    expect(() => parseImportFile("  \n ", "f.json")).toThrow(/empty/);
  });

  it("rejects invalid JSON with the file name in the message", () => {
    expect(() => parseImportFile("[{oops]", "f.json")).toThrow(/f\.json: invalid JSON/);
  });

  it("rejects NDJSON with a broken line, naming the line", () => {
    expect(() => parseImportFile('{"a":1}\n{nope}\n', "f.ndjson")).toThrow(/line 2/);
  });

  it("rejects non-object documents (array and NDJSON)", () => {
    expect(() => parseImportFile("[1,2]", "f.json")).toThrow(/document #1 is not a JSON object/);
    expect(() => parseImportFile('[{"a":1},[3]]', "f.json")).toThrow(
      /document #2 is not a JSON object/,
    );
    // `42` parses as JSON but isn't an object — caught by doc validation.
    expect(() => parseImportFile('{"a":1}\n42\n', "f.ndjson")).toThrow(
      /document #2 is not a JSON object/,
    );
  });

  it("rejects input that is neither an array nor NDJSON", () => {
    expect(() => parseImportFile('"hello"', "f.json")).toThrow(/JSON array.*NDJSON/);
  });
});

describe("isValidCollectionName", () => {
  it("accepts identifier-style names", () => {
    for (const ok of ["movies", "order_items", "_tmp", "C9"]) {
      expect(isValidCollectionName(ok)).toBe(true);
    }
  });

  it("rejects anything else (injection surface)", () => {
    for (const bad of ["", "9lives", "my-coll", "a b", "x;DROP TABLE y", 'a"b', "system:x"]) {
      expect(isValidCollectionName(bad)).toBe(false);
    }
  });
});

describe("importDocuments", () => {
  function recordingExecutor() {
    const calls: { statement: string; args?: Record<string, string> }[] = [];
    const executor: QueryExecutor = {
      execute: async (statement, args) => {
        calls.push({ statement, args: args as Record<string, string> });
        return { items: [] } as unknown as QueryResult;
      },
    };
    return { executor, calls };
  }

  it("inserts in batches with upsert semantics (deserialize_json args)", async () => {
    const { executor, calls } = recordingExecutor();
    const docs = Array.from({ length: 5 }, (_, i) => ({ _id: `d${i}` }));
    const n = await importDocuments(executor, docs, "things", { batchSize: 2 });
    expect(n).toBe(5);
    expect(calls.length).toBe(3); // 2 + 2 + 1
    expect(calls[0]!.statement).toBe(
      "INSERT INTO things DOCUMENTS (deserialize_json(:doc0)), (deserialize_json(:doc1)) ON ID CONFLICT DO UPDATE",
    );
    expect(JSON.parse(calls[0]!.args!.doc0!)).toEqual({ _id: "d0" });
    expect(calls[2]!.statement).toContain("doc0");
    expect(calls[2]!.statement).not.toContain("doc1");
  });

  it("generates a UUID _id for docs that lack one, keeps existing _ids", async () => {
    const { executor, calls } = recordingExecutor();
    await importDocuments(executor, [{ name: "no id" }, { _id: "keep-me" }], "things");
    const [first, second] = Object.values(calls[0]!.args!).map((s) => JSON.parse(s));
    expect(first._id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(first.name).toBe("no id");
    expect(second._id).toBe("keep-me");
  });

  it("reports progress after each batch", async () => {
    const { executor } = recordingExecutor();
    const onProgress = vi.fn();
    const docs = Array.from({ length: 3 }, (_, i) => ({ _id: `d${i}` }));
    await importDocuments(executor, docs, "things", { batchSize: 2, onProgress });
    expect(onProgress.mock.calls).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });

  it("an empty import runs no statements", async () => {
    const { executor, calls } = recordingExecutor();
    expect(await importDocuments(executor, [], "things")).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("query errors propagate (caller maps to exit 1)", async () => {
    const executor: QueryExecutor = {
      execute: async () => {
        throw new Error("boom");
      },
    };
    await expect(importDocuments(executor, [{ _id: "1" }], "things")).rejects.toThrow("boom");
  });
});
