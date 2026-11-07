import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../../src/ditto/session.js";
import { LESSONS, SEED_PRODUCTS, SEED_SUPPLIERS } from "../../src/tutorial/lessons.js";
import { LessonRunner } from "../../src/tutorial/runner.js";
import {
  caseMismatch,
  collectionsIn,
  inferSchema,
  schemaLines,
} from "../../src/tutorial/schema.js";

describe("inferSchema", () => {
  it("lists every field path with types, counts, and a sample value", () => {
    const fields = inferSchema(SEED_PRODUCTS as never);
    const by = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(fields[0]!.path).toBe("_id");
    expect(by.name).toMatchObject({ types: ["string"], count: 6, example: "Coffee beans" });
    expect(by.details).toMatchObject({ types: ["object"], count: 3 });
    expect(by["details.origin"]).toMatchObject({ count: 3, example: "Colombia" });
    expect(by["details.roast"]?.count).toBe(2);
    expect(by.discount).toMatchObject({ types: ["number", "null"], count: 2 });
    expect(by.tags).toMatchObject({ types: ["array"], count: 6 });
    expect(by.tags?.example).toEqual(["organic", "fair-trade"]);
  });

  it("describes arrays of objects with [] paths", () => {
    const fields = inferSchema([
      { _id: "o1", lines: [{ sku: "p1", qty: 2 }] },
      { _id: "o2", lines: [] },
      { _id: "o3", flag: true, nothing: null },
    ]);
    const by = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(by.lines).toMatchObject({ types: ["array"], count: 2 });
    expect(by.lines?.example).toBeUndefined(); // objects, not scalars
    expect(by["lines[].sku"]).toMatchObject({ types: ["string"], count: 1, example: "p1" });
    expect(by["lines[].qty"]?.example).toBe(2);
    expect(by.flag?.example).toBe(true);
    expect(by.nothing).toMatchObject({ types: ["null"] });
    expect(by.nothing?.example).toBeUndefined();
    expect(inferSchema([])).toEqual([]);
  });
});

describe("collectionsIn", () => {
  it("finds the collections a statement uses", () => {
    expect(collectionsIn("SELECT * FROM products")).toEqual(["products"]);
    expect(
      collectionsIn(
        "SELECT p.name FROM products AS p LEFT JOIN suppliers AS s ON p.supplier_id = s._id",
      ),
    ).toEqual(["products", "suppliers"]);
    expect(collectionsIn("INSERT INTO products VALUES ({'_id': 'x'})")).toEqual(["products"]);
    expect(collectionsIn("UPDATE products SET stock = 1")).toEqual(["products"]);
    expect(collectionsIn("EVICT FROM products USE IDS 'p7'")).toEqual(["products"]);
    expect(collectionsIn("CREATE INDEX IF NOT EXISTS i ON products (category)")).toEqual([
      "products",
    ]);
    expect(collectionsIn("SELECT key FROM system:system_info")).toEqual(["system:system_info"]);
    // Words inside strings don't count.
    expect(collectionsIn("SELECT * FROM products WHERE name = 'from orders'")).toEqual([
      "products",
    ]);
  });

  it("every lesson names at least one collection, and the join lessons name two", () => {
    for (const l of LESSONS) expect(collectionsIn(l.answer).length, l.title).toBeGreaterThan(0);
    const join = LESSONS.find((l) => l.title === "Joining collections")!;
    expect(collectionsIn(join.answer)).toEqual(["products", "suppliers"]);
  });
});

describe("schemaLines", () => {
  const schema = (docs: Record<string, unknown>[], more = false) => ({
    collection: "suppliers",
    documents: docs.length,
    more,
    fields: inferSchema(docs),
  });

  it("shows the collection, its fields, partial counts, and examples that fit", () => {
    const lines = schemaLines(
      [schema(SEED_SUPPLIERS as never), schema([{ _id: "a" }, { _id: "b", x: 1 }], true)],
      60,
    ).map(strip);
    expect(lines[0]).toBe("suppliers  3 documents");
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}name\s+string\s+'Andes Roasters'$/));
    expect(lines).toContain("");
    expect(lines).toContain("suppliers  2+ documents");
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}x\s+number · 1 of 2\s+1$/));
  });

  it("drops examples when there's no room, and handles an empty collection", () => {
    const narrow = schemaLines([schema(SEED_SUPPLIERS as never)], 22).map(strip);
    expect(narrow.some((l) => l.includes("'Andes"))).toBe(false);
    const empty = schemaLines([schema([])], 40).map(strip);
    expect(empty).toEqual(["suppliers  0 documents", "  (no documents)"]);
    const one = schemaLines([schema([{ _id: "a" }])], 40).map(strip);
    expect(one[0]).toBe("suppliers  1 document");
  });
});

describe("caseMismatch", () => {
  const known = { collections: ["products", "suppliers"], fields: ["name", "category"] };

  it("points out names that differ only in case", () => {
    expect(caseMismatch("SELECT * FROM Products", known)).toContain(
      "`Products` is a different (empty) collection from `products`",
    );
    expect(caseMismatch("SELECT Name FROM products", known)).toContain(
      "`Name` isn't the same field as `name`",
    );
  });

  it("is quiet when names match, and ignores text in strings", () => {
    expect(caseMismatch("select name from products where category = 'tea'", known)).toBeNull();
    expect(caseMismatch("SELECT * FROM products WHERE name = 'Name'", known)).toBeNull();
    expect(caseMismatch("SELECT * FROM orders", known)).toBeNull();
  });
});

describe("LessonRunner data view", () => {
  function runner(at: string) {
    const executed: string[] = [];
    const printed: string[] = [];
    const session: QueryExecutor = {
      execute: async (s: string) => {
        executed.push(s);
        const rows = /FROM products/.test(s)
          ? SEED_PRODUCTS
          : /FROM suppliers/.test(s)
            ? SEED_SUPPLIERS
            : [];
        return { items: rows.map((value) => ({ value })) } as never;
      },
    };
    const r = new LessonRunner(session, {
      io: { print: (t) => printed.push(t), width: () => 80 },
      progress: { lesson: LESSONS.findIndex((l) => l.title === at), completed: [] },
    });
    return { r, executed, printed };
  }

  it("lists the lesson's collections and reads their live schema", async () => {
    const { r, executed, printed } = runner("Joining collections");
    expect(r.collections()).toEqual(["products", "suppliers"]);
    expect(strip(r.dataTip("Ctrl+T"))).toBe(
      "Collections: products, suppliers · Ctrl+T shows their fields",
    );
    const schemas = await r.schema();
    expect(schemas.map((s) => [s.collection, s.documents, s.more])).toEqual([
      ["products", 6, false],
      ["suppliers", 3, false],
    ]);
    expect(executed).toContain("SELECT * FROM products LIMIT 201");
    await r.printSchema();
    const out = strip(printed.join("\n"));
    expect(out).toContain("supplier_id");
    expect(out).toContain("Names are case-sensitive");
  });

  it("one collection reads 'its fields'; the plain card shows the .schema tip", async () => {
    const { r, printed } = runner("Documents and collections");
    expect(strip(r.dataTip(".schema"))).toBe("Collection: products · .schema shows its fields");
    await r.show();
    expect(strip(printed.join("\n"))).toContain(".schema shows its fields");
  });

  it("a wrong-case collection name gets a case-sensitivity explanation", async () => {
    const { r, printed } = runner("Documents and collections");
    expect(await r.submit("SELECT * FROM Products")).toBe(false);
    expect(strip(printed.join("\n"))).toContain("Collection names are case-sensitive");
  });
});
