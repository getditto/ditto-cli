import type { StatementKind } from "../query/execute.js";

/**
 * Interactive DQL lessons for `dittosh tutorial --interactive`, in three
 * levels. Each lesson teaches a concept (what it is and why it matters, with
 * an "if you know SQL" note), shows the syntax, then sets a task.
 *
 * Every lesson runs against a practice store seeded by RESET_STATEMENTS.
 * Checks inspect the result rows (or, for writes, re-query the store), so any
 * correct statement passes — not just the sample answer. Every sample answer
 * is verified against the real SDK in tests/integration/lessons.test.ts.
 */

export type Level = "beginner" | "intermediate" | "advanced";
export const LEVELS: readonly Level[] = ["beginner", "intermediate", "advanced"];

export type CheckResult = { pass: true } | { pass: false; reason: string };

export interface LessonCheckContext {
  statement: string;
  kind: StatementKind;
  rows: Record<string, unknown>[];
  /** Run a read-only follow-up query against the practice store. */
  query: (statement: string) => Promise<Record<string, unknown>[]>;
}

export interface Lesson {
  level: Level;
  title: string;
  /** The idea: what it is and why it matters. `code` spans are highlighted. */
  concept: string;
  /** Optional comparison for readers who know SQL. */
  sql?: string;
  /** Syntax examples, one per line. */
  syntax: string[];
  /** What to do. */
  task: string;
  hint: string;
  /** A sample statement that passes. */
  answer: string;
  /** Statements run when the lesson starts, so lessons work in any order. */
  setup?: string[];
  check: (ctx: LessonCheckContext) => CheckResult | Promise<CheckResult>;
  /** Shown after a pass: the takeaway. */
  success: string;
  /** SDK version that introduced or fixed the behavior this lesson shows. */
  newIn?: string;
}

export const SEED_PRODUCTS = [
  {
    _id: "p1",
    name: "Coffee beans",
    category: "coffee",
    price: 12.5,
    stock: 20,
    tags: ["organic", "fair-trade"],
    details: { origin: "Colombia", roast: "dark" },
    supplier_id: "s1",
  },
  {
    _id: "p2",
    name: "Paper filters",
    category: "coffee",
    price: 5,
    stock: 100,
    tags: [],
    supplier_id: "s2",
  },
  {
    _id: "p3",
    name: "Green tea",
    category: "tea",
    price: 9,
    stock: 30,
    tags: ["organic"],
    details: { origin: "Japan" },
    supplier_id: "s3",
  },
  {
    _id: "p4",
    name: "Espresso blend",
    category: "coffee",
    price: 15,
    stock: 0,
    tags: ["fair-trade"],
    details: { origin: "Brazil", roast: "medium" },
    supplier_id: "s1",
    discount: 0.1,
  },
  {
    _id: "p5",
    name: "Chai spices",
    category: "tea",
    price: 7.25,
    stock: 45,
    tags: ["organic", "spicy"],
    supplier_id: "s3",
    discount: null,
  },
  {
    _id: "p6",
    name: "Travel mug",
    category: "accessories",
    price: 18,
    stock: 12,
    tags: [],
    // No supplier s4 exists: the outer-join lesson finds this product.
    supplier_id: "s4",
  },
] as const;

export const SEED_SUPPLIERS = [
  { _id: "s1", name: "Andes Roasters", country: "Colombia" },
  { _id: "s2", name: "Kitchen Goods Co", country: "USA" },
  { _id: "s3", name: "Leaf & Spice", country: "India" },
] as const;

export const SEED_ORDERS = [
  {
    _id: "o1",
    lines: [
      { sku: "p1", qty: 2 },
      { sku: "p2", qty: 1 },
    ],
  },
  {
    _id: "o2",
    lines: [
      { sku: "p1", qty: 1 },
      { sku: "p3", qty: 5 },
    ],
  },
  { _id: "o3", lines: [{ sku: "p5", qty: 3 }] },
] as const;

export const PRACTICE_INDEX = "idx_products_category";
export const COMPOSITE_INDEX = "idx_products_category_price";

/** DQL object literal (single-quoted strings) for a plain JSON value. */
function dqlLiteral(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(dqlLiteral).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as object)
      .map(([k, x]) => `'${k}': ${dqlLiteral(x)}`)
      .join(", ")}}`;
  }
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  return String(v);
}

function insertAll(collection: string, docs: readonly object[]): string {
  return `INSERT INTO ${collection} VALUES ${docs.map((d) => `(${dqlLiteral(d)})`).join(", ")} ON ID CONFLICT DO UPDATE`;
}

/** Restore the practice data exactly (`.reset`, and every start). */
export const RESET_STATEMENTS = [
  "EVICT FROM products",
  "EVICT FROM suppliers",
  "EVICT FROM orders",
  `DROP INDEX IF EXISTS ${PRACTICE_INDEX} ON products`,
  `DROP INDEX IF EXISTS ${COMPOSITE_INDEX} ON products`,
  insertAll("products", SEED_PRODUCTS),
  insertAll("suppliers", SEED_SUPPLIERS),
  insertAll("orders", SEED_ORDERS),
];

const NAME_BY_ID = new Map<string, string>(SEED_PRODUCTS.map((p) => [p._id, p.name]));
const ALL_NAMES = SEED_PRODUCTS.map((p) => p.name);

/** Product names in the rows (via `name`, or mapped from `_id`), or undefined. */
function productNames(rows: Record<string, unknown>[]): string[] | undefined {
  const names: string[] = [];
  for (const r of rows) {
    if (typeof r.name === "string") names.push(r.name);
    else if (typeof r._id === "string" && NAME_BY_ID.has(r._id)) names.push(NAME_BY_ID.get(r._id)!);
    else return undefined;
  }
  return names;
}

function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  const key = (xs: readonly unknown[]) => xs.map(String).sort().join("\u0000");
  return a.length === b.length && key(a) === key(b);
}

const fail = (reason: string): CheckResult => ({ pass: false, reason });
const pass: CheckResult = { pass: true };

/** Pass when the rows name exactly `expected` (any order). */
function expectProducts(rows: Record<string, unknown>[], expected: readonly string[]): CheckResult {
  const names = productNames(rows);
  if (!names) return fail("Include the `name` field (or `_id`) so each product can be identified.");
  if (sameSet(names, expected)) return pass;
  return fail(
    `Expected ${expected.length} product${expected.length === 1 ? "" : "s"}, got ${names.length}: ${names.join(", ") || "none"}.`,
  );
}

/** Every primitive value in the rows, flattened (alias-agnostic checks). */
function allValues(rows: Record<string, unknown>[]): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else out.push(v);
  };
  rows.forEach(walk);
  return out;
}

const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;

function rowFor(rows: Record<string, unknown>[], name: string) {
  return rows.find((r) => r.name === name);
}

export const LESSONS: Lesson[] = [
  // ─── Beginner ───────────────────────────────────────────────────────────
  {
    level: "beginner",
    title: "Documents and collections",
    concept: `A Ditto database stores **documents**: self-describing records made of fields,
like \`{ name: 'Green tea', price: 9 }\`. Documents are grouped into **collections**,
and every document has a unique \`_id\`. A **query** asks the database for the
documents you want; DQL (Ditto Query Language) is how you write one.

Collection and field names are **case-sensitive**: \`products\` and \`Products\` are
two different collections, and querying one that doesn't exist just returns
nothing. Keywords like \`SELECT\` and \`FROM\` work in any case.`,
    sql: "A collection is like a table and a document like a row, except documents in one collection don't need the same fields.",
    syntax: ["SELECT * FROM collection"],
    task: "Show every document in the `products` collection.",
    hint: "`SELECT *` means every field; the collection's name goes after `FROM`.",
    answer: "SELECT * FROM products",
    check: ({ rows }) => expectProducts(rows, ALL_NAMES),
    success: "Six documents. Notice the different shapes: some have `details`, some a `discount`.",
  },
  {
    level: "beginner",
    title: "Projection: choosing fields",
    concept: `A **projection** decides the **shape** of each result: which fields come back, and
under what names. It doesn't change **which** documents match — that's filtering,
next lesson. Think of filtering as picking rows and projection as picking columns.
Asking only for what you need keeps results small and readable.`,
    sql: "Same as listing columns in SQL's SELECT clause.",
    syntax: [
      "SELECT name, country FROM suppliers",
      "SELECT name AS supplier FROM suppliers   -- rename",
    ],
    task: "Show only the `name` and `price` of each product.",
    hint: "Replace `*` with a comma-separated list of fields.",
    answer: "SELECT name, price FROM products",
    check: ({ rows }) => {
      if (rows.length !== SEED_PRODUCTS.length) return fail("Return all six products.");
      const keys = (r: Record<string, unknown>) => Object.keys(r).sort().join(",");
      return rows.every((r) => keys(r) === "name,price")
        ? pass
        : fail("Each row should contain exactly two fields: `name` and `price`.");
    },
    success: "`AS` renames a field in the output: `SELECT name AS product FROM products`.",
  },
  {
    level: "beginner",
    title: "Filtering with predicates",
    concept: `A **predicate** is a condition that is true or false for each document, such as
\`category = 'tea'\`. \`WHERE\` evaluates the predicate against every document and keeps
only those where it's true. Text values go in single quotes; numbers don't.`,
    sql: "Identical to SQL's WHERE clause.",
    syntax: [
      "SELECT * FROM products WHERE category = 'tea'",
      "SELECT * FROM products WHERE price > 10      -- also: = != < <= >=",
    ],
    task: "Find the products whose category is `coffee`, and show their names.",
    hint: "Compare the `category` field to a text value in a WHERE clause — text goes in single quotes.",
    answer: "SELECT name, price FROM products WHERE category = 'coffee'",
    check: ({ rows }) => expectProducts(rows, ["Coffee beans", "Paper filters", "Espresso blend"]),
    success: "Filtering (WHERE) and projection (SELECT list) combine freely in one query.",
  },
  {
    level: "beginner",
    title: "Combining conditions",
    concept: `Predicates combine with **boolean logic**: \`AND\` (both must be true), \`OR\` (either
is enough), and \`NOT\` (flips true and false). \`AND\` binds tighter than \`OR\`, so use
parentheses to make your intent clear. Shortcuts: \`BETWEEN low AND high\`
(inclusive), \`IN [list]\`, and \`LIKE\` with \`%\` as a wildcard.`,
    sql: "The same operators as SQL; DQL writes IN lists with square brackets.",
    syntax: [
      "SELECT name, stock FROM products WHERE stock BETWEEN 10 AND 40",
      "WHERE category = 'tea' AND price < 8",
      "WHERE (category = 'tea' OR category = 'coffee') AND stock > 0",
      "WHERE category IN ['tea', 'accessories']",
      "WHERE name LIKE '%tea%'",
    ],
    task: "Find the products that cost between 5 and 10 (including exactly 5 or 10), and show their names.",
    hint: "`BETWEEN low AND high` includes both ends — or combine `>=` and `<=` with AND.",
    answer: "SELECT name, price FROM products WHERE price BETWEEN 5 AND 10",
    check: ({ rows }) => expectProducts(rows, ["Paper filters", "Green tea", "Chai spices"]),
    success: "`BETWEEN` includes both ends, so Paper filters, at exactly 5, made the cut.",
  },
  {
    level: "beginner",
    title: "Sorting and limiting",
    concept: `Results have **no guaranteed order** unless you ask for one. \`ORDER BY\` sorts by
one or more fields — ascending by default, \`DESC\` for descending. \`LIMIT n\` keeps
only the first n results, and \`OFFSET n\` skips some first (useful for paging).`,
    sql: "Same as SQL's ORDER BY / LIMIT / OFFSET.",
    syntax: [
      "SELECT name, price FROM products ORDER BY price",
      "SELECT name, stock FROM products ORDER BY stock DESC LIMIT 3",
    ],
    task: "Show the names of the two most expensive products, with the most expensive first.",
    hint: "Sort high-to-low with `DESC`, then keep only the first rows with `LIMIT`.",
    answer: "SELECT name, price FROM products ORDER BY price DESC LIMIT 2",
    check: ({ rows }) => {
      const names = productNames(rows);
      if (!names) return fail("Include the `name` field.");
      return names.join("|") === "Travel mug|Espresso blend"
        ? pass
        : fail(`Expected Travel mug, then Espresso blend — got ${names.join(", ") || "nothing"}.`);
    },
    success: "Add `LIMIT` to exploratory queries so large collections stay fast.",
  },
  {
    level: "beginner",
    title: "Inserting documents",
    concept: `Queries read data; **statements** like INSERT, UPDATE, and EVICT change it.
\`INSERT INTO … VALUES (…)\` adds documents written as object literals — one or
more, separated by commas. If a document with that \`_id\` already exists, the
insert fails — unless you add \`ON ID CONFLICT DO UPDATE\`, which makes the
insert safe to repeat. (Older examples use \`DOCUMENTS\` in place of \`VALUES\`;
the two work the same.)`,
    sql: "The same INSERT … VALUES you know, except each value is a whole document rather than a row of columns.",
    syntax: [
      "INSERT INTO products VALUES ({'_id': 'p9', 'name': 'Kettle', 'price': 30})",
      "… ON ID CONFLICT DO UPDATE   -- upsert",
    ],
    task: "Insert a new product with `_id` 'p7', name 'Cold brew kit', category 'coffee', and price 25.",
    hint: "Write the fields as `'key': value` pairs inside `({ … })` — text in single quotes, numbers without.",
    answer:
      "INSERT INTO products VALUES ({'_id': 'p7', 'name': 'Cold brew kit', 'category': 'coffee', 'price': 25})",
    setup: ["EVICT FROM products WHERE _id = 'p7'"],
    check: async ({ query }) => {
      const [doc] = await query("SELECT * FROM products WHERE _id = 'p7'");
      if (!doc) return fail("No document with `_id` 'p7' yet.");
      if (doc.name !== "Cold brew kit" || doc.category !== "coffee" || doc.price !== 25) {
        return fail("p7 exists, but check its name, category, and price.");
      }
      return pass;
    },
    success: "Writes are saved locally at once. On a syncing device, peers would receive them.",
  },
  {
    level: "beginner",
    title: "Updating documents",
    concept: `\`UPDATE … SET field = value WHERE …\` changes the documents the predicate matches.
The new value can be computed from the old one (\`stock = stock + 10\`), and nested
fields work too (\`SET details.roast = 'light'\`). **Always include WHERE** — without
it, every document in the collection changes.`,
    sql: "Same as SQL UPDATE.",
    syntax: [
      "UPDATE products SET price = 10 WHERE _id = 'p3'",
      "UPDATE products SET stock = stock + 5 WHERE category = 'tea'",
    ],
    task: "The Espresso blend (`_id` 'p4') has been restocked. Set its `stock` to 25.",
    hint: "SET the field to its new value, and use WHERE on `_id` so only that one document changes.",
    answer: "UPDATE products SET stock = 25 WHERE _id = 'p4'",
    setup: ["UPDATE products SET stock = 0 WHERE _id = 'p4'"],
    check: async ({ query }) => {
      const [doc] = await query("SELECT stock FROM products WHERE _id = 'p4'");
      return doc?.stock === 25 ? pass : fail(`p4's stock is ${String(doc?.stock)}, not 25.`);
    },
    success: "Ditto merges concurrent updates from different devices field by field.",
  },
  {
    level: "beginner",
    title: "Removing local data",
    concept: `\`EVICT FROM … WHERE …\` removes documents from **this device's** store only.
That's different from \`DELETE\`, which is synchronized: it tells every peer the
document is gone. This CLI is offline-only, so here both affect just your store.`,
    sql: "EVICT has no SQL equivalent; DELETE is the closest.",
    syntax: ["EVICT FROM products WHERE _id = 'p9'"],
    task: "Evict the Cold brew kit (`_id` 'p7') from the local store.",
    hint: "`EVICT FROM` the collection, with a WHERE that matches only that `_id`.",
    answer: "EVICT FROM products WHERE _id = 'p7'",
    setup: [
      "INSERT INTO products VALUES ({'_id': 'p7', 'name': 'Cold brew kit', 'category': 'coffee', 'price': 25}) ON ID CONFLICT DO UPDATE",
    ],
    check: async ({ query }) => {
      const rows = await query("SELECT _id FROM products WHERE _id = 'p7'");
      return rows.length === 0 ? pass : fail("p7 is still in the store.");
    },
    success: "That's the beginner level: read, filter, shape, sort, and write documents.",
  },

  // ─── Intermediate ───────────────────────────────────────────────────────
  {
    level: "intermediate",
    title: "Expressions and functions",
    concept: `An **expression** computes a value for each document, such as \`price * 2\` or
\`stock - 1\`. A **function** is a named operation that takes inputs (arguments) and
returns a value: \`upper(name)\` turns 'Green tea' into 'GREEN TEA'. These are
**scalar** functions — they run once per document. Others: \`lower\`, \`length\`,
\`concat\`, \`round\`. Name a computed column with \`AS\`.`,
    sql: "Scalar functions and expressions work as in SQL.",
    syntax: [
      "SELECT name, price * 1.2 AS with_tax FROM products",
      "SELECT concat(name, ' (', category, ')') AS label FROM products",
      "SELECT round(price / 3, 2) AS third FROM products",
    ],
    task: "Show the name of every product in upper case.",
    hint: "DQL has text functions such as `lower()` and `upper()` — call one on `name` in the SELECT list.",
    answer: "SELECT name, upper(name) AS shout FROM products",
    check: ({ rows }) => {
      if (rows.length !== SEED_PRODUCTS.length) return fail("Return all six products.");
      return allValues(rows).includes("COFFEE BEANS")
        ? pass
        : fail("Expected values like 'COFFEE BEANS' — use `upper(name)`.");
    },
    success: "Functions nest: `length(upper(name))` passes one function's result to another.",
  },
  {
    level: "intermediate",
    title: "Conditional values with CASE",
    concept: `\`CASE\` is an if/else expression: it checks conditions in order and returns the
value of the first one that's true, or the \`ELSE\` value. It's handy for labels
and buckets.`,
    sql: "Same as SQL's searched CASE expression.",
    syntax: [
      "SELECT name, CASE WHEN price >= 10 THEN 'premium' ELSE 'standard' END AS tier FROM products",
      "CASE WHEN condition THEN value WHEN … THEN … ELSE value END   -- the general form",
    ],
    task: "For each product, show its name and a label: 'in stock' if its stock is above 0, otherwise 'sold out'.",
    hint: "Inside `CASE WHEN … THEN … ELSE … END`, test `stock > 0`, and name the result with `AS`.",
    answer:
      "SELECT name, CASE WHEN stock > 0 THEN 'in stock' ELSE 'sold out' END AS availability FROM products",
    setup: ["UPDATE products SET stock = 0 WHERE _id = 'p4'"],
    check: ({ rows }) => {
      if (rows.length !== SEED_PRODUCTS.length) return fail("Return all six products.");
      const espresso = rowFor(rows, "Espresso blend");
      const tea = rowFor(rows, "Green tea");
      if (!espresso || !tea) return fail("Include the `name` field.");
      if (!Object.values(espresso).includes("sold out"))
        return fail("The Espresso blend (stock 0) should be labeled 'sold out'.");
      if (!Object.values(tea).includes("in stock"))
        return fail("Products with stock should be labeled 'in stock'.");
      return pass;
    },
    success: "CASE works anywhere an expression does: in WHERE, ORDER BY, even inside functions.",
  },
  {
    level: "intermediate",
    title: "MISSING versus NULL",
    concept: `Because documents can differ, a field can be absent in two ways. **MISSING**
means the document doesn't have the field at all. **NULL** means the field exists
but holds no value. \`IS MISSING\` / \`IS NOT MISSING\` and \`IS NULL\` / \`IS NOT NULL\`
test each case. In the practice data, only the Espresso blend has a real
discount, the Chai spices has \`discount: null\`, and the rest have no discount
field.`,
    sql: "SQL has only NULL; MISSING is unique to document databases.",
    syntax: [
      "SELECT name, details FROM products WHERE details IS MISSING",
      "WHERE details IS NOT MISSING",
      "WHERE field IS NULL",
    ],
    task: "Find the product whose `discount` is NULL (the field is there but empty), and show its name.",
    hint: "MISSING means the field isn't there; NULL means it's there but empty. You want NULL.",
    answer: "SELECT name, discount FROM products WHERE discount IS NULL",
    check: ({ rows }) => expectProducts(rows, ["Chai spices"]),
    success: "`IS MISSING` would have found the other four, which have no discount field at all.",
  },
  {
    level: "intermediate",
    title: "Defaults with coalesce",
    concept: `Arithmetic on a missing or null value has no result, so \`price * (1 - discount)\`
yields nothing for products without a discount. \`coalesce(a, b, …)\` returns its
first argument that has a value, so \`coalesce(discount, 0)\` supplies a default.`,
    sql: "Same as SQL's COALESCE.",
    syntax: [
      "coalesce(value, fallback)   -- the first one that isn't NULL or MISSING",
      "SELECT name, coalesce(details.roast, 'none') AS roast FROM products",
    ],
    task: "Show each product's name and its sale price, `price * (1 - discount)`. Treat a missing or NULL discount as 0.",
    hint: "`coalesce(discount, 0)` is 0 when there's no discount — use it in place of `discount` in the formula.",
    answer:
      "SELECT name, price * (1 - coalesce(discount, 0)) AS sale_price FROM products ORDER BY sale_price",
    check: ({ rows }) => {
      if (rows.length !== SEED_PRODUCTS.length) return fail("Return all six products.");
      const values = allValues(rows);
      if (!values.some((v) => near(v, 13.5)))
        return fail("The Espresso blend should cost 13.5 after its 10% discount.");
      if (!values.some((v) => near(v, 7.25)))
        return fail("Chai spices (null discount) should keep its 7.25 price — use `coalesce`.");
      return pass;
    },
    success: "Without coalesce, five of the six products would have no sale price.",
  },
  {
    level: "intermediate",
    title: "Nested objects",
    concept: `Fields can hold objects, which keeps related data together in one document.
Some products have a \`details\` object holding their \`origin\` and \`roast\`:

  { name: 'Espresso blend', details: { origin: 'Brazil', roast: 'medium' } }

Reach inside with a **dot path**: \`details.origin\`. Dot paths work in projections,
predicates, sorting, and indexes.`,
    sql: "Like reading a JSON column, but without special JSON functions.",
    syntax: ["SELECT name, details.roast FROM products WHERE details.origin = 'Brazil'"],
    task: "Show the name and origin of each product whose `details` has a `dark` roast.",
    hint: "Reach into the nested object with a dot: `details.roast` and `details.origin`.",
    answer: "SELECT name, details.origin FROM products WHERE details.roast = 'dark'",
    check: ({ rows }) => {
      if (rows.length !== 1) return fail("Exactly one product has a dark roast.");
      return allValues(rows).includes("Colombia")
        ? pass
        : fail("Include the origin (`details.origin`) in the result.");
    },
    success: "Updates use the same paths: `UPDATE products SET details.roast = 'light' WHERE …`.",
  },
  {
    level: "intermediate",
    title: "Arrays",
    concept: `A field can hold an **array** (a list), like \`tags\`. Array functions inspect it:
\`array_contains(tags, 'spicy')\` tests for a value and \`array_length(tags)\` counts
the elements. \`tags[0]\` reads the first element.`,
    sql: "Similar to PostgreSQL arrays.",
    syntax: [
      "WHERE array_contains(tags, 'fair-trade')",
      "SELECT name, tags[0] AS first_tag FROM products WHERE array_length(tags) > 0",
    ],
    task: "Find the products tagged `organic`, and show their names.",
    hint: "`array_contains(array, value)` is true when the array holds that value.",
    answer: "SELECT name, tags FROM products WHERE array_contains(tags, 'organic')",
    check: ({ rows }) => expectProducts(rows, ["Coffee beans", "Green tea", "Chai spices"]),
    success: "Arrays are values too — you can return them, as you just did with `tags`.",
  },
  {
    level: "intermediate",
    title: "Aggregate functions",
    concept: `Scalar functions run once per document. **Aggregate functions** do the opposite:
they combine many documents into one value. \`count(*)\` counts documents,
\`count(field)\` counts documents where the field has a value, and \`sum\`, \`avg\`,
\`min\`, and \`max\` summarize numbers. Without GROUP BY, the whole result collapses
into a single row.`,
    sql: "Same aggregate functions as SQL.",
    syntax: ["SELECT count(*) AS products, max(price) AS top_price FROM products"],
    task: "In a single row, show the number of products and their average price.",
    hint: "`count(*)` counts documents and `avg()` averages a field — both in one SELECT give a single row.",
    answer: "SELECT count(*) AS products, avg(price) AS avg_price FROM products",
    check: ({ rows }) => {
      if (rows.length !== 1) return fail("Aggregates without GROUP BY return a single row.");
      const values = allValues(rows);
      if (!values.some((v) => v === SEED_PRODUCTS.length)) return fail("Include `count(*)` (6).");
      return values.some((v) => near(v, 11.125)) ? pass : fail("Include `avg(price)` (11.125).");
    },
    success: "`count(discount)` would return 1: it skips missing and null values.",
  },
  {
    level: "intermediate",
    title: "Grouping",
    concept: `\`GROUP BY field\` splits the documents into groups that share a value, then runs
the aggregate functions once **per group**. Every field you select must be either
grouped or aggregated.`,
    sql: "Same as SQL GROUP BY.",
    syntax: [
      "SELECT country, count(*) AS suppliers FROM suppliers GROUP BY country",
      "SELECT category, max(price) AS top_price FROM products GROUP BY category",
    ],
    task: "Show each category and how many products it has.",
    hint: "GROUP BY the field you want one row for, and `count(*)` each group.",
    answer: "SELECT category, count(*) AS products FROM products GROUP BY category",
    check: ({ rows }) => {
      const expected: Record<string, number> = { coffee: 3, tea: 2, accessories: 1 };
      if (rows.length !== 3) return fail("Return one row per category (3 rows).");
      for (const r of rows) {
        const cat = r.category;
        if (typeof cat !== "string" || !(cat in expected))
          return fail("Include the `category` field.");
        if (!Object.entries(r).some(([k, v]) => k !== "category" && v === expected[cat])) {
          return fail(`The ${cat} row should count ${expected[cat]} products.`);
        }
      }
      return pass;
    },
    success: "Add more aggregates to the same query: `avg(price)`, `sum(stock)`, …",
  },
  {
    level: "intermediate",
    title: "Filtering groups with HAVING",
    concept: `\`WHERE\` filters documents **before** grouping. \`HAVING\` filters the groups **after**
the aggregates are computed, so it can test them: \`HAVING sum(stock) > 50\`.`,
    sql: "Same as SQL HAVING.",
    syntax: [
      "SELECT category, avg(price) AS avg_price FROM products GROUP BY category HAVING avg(price) > 10",
    ],
    task: "Show the categories whose total stock is more than 50 units.",
    hint: "Total the stock per category with `sum(stock)`; HAVING keeps only the groups you want.",
    answer:
      "SELECT category, sum(stock) AS units FROM products GROUP BY category HAVING sum(stock) > 50",
    setup: ["UPDATE products SET stock = 0 WHERE _id = 'p4'"],
    check: ({ rows }) => {
      const cats = rows.map((r) => r.category);
      if (cats.some((c) => typeof c !== "string")) return fail("Include the `category` field.");
      return sameSet(cats, ["coffee", "tea"])
        ? pass
        : fail(`Expected coffee (120 units) and tea (75) — got ${cats.join(", ") || "none"}.`);
    },
    success: "Accessories (12 units) was grouped, then removed by HAVING.",
  },
  {
    level: "intermediate",
    title: "Removing duplicates with DISTINCT",
    concept: `\`SELECT DISTINCT\` removes duplicate result rows, so each combination of the
selected values appears once. It's a quick way to see which values a field takes.`,
    sql: "Same as SQL DISTINCT.",
    syntax: ["SELECT DISTINCT supplier_id FROM products"],
    task: "List each category once, with no duplicates.",
    hint: "`DISTINCT` goes right after SELECT.",
    answer: "SELECT DISTINCT category FROM products",
    check: ({ rows }) =>
      sameSet(
        rows.map((r) => r.category),
        ["coffee", "tea", "accessories"],
      )
        ? pass
        : fail("Expected three rows: coffee, tea, and accessories."),
    success:
      "That's the intermediate level: expressions, functions, missing data, and aggregation.",
  },

  // ─── Advanced ───────────────────────────────────────────────────────────
  {
    level: "advanced",
    title: "Joining collections",
    concept: `Related data often lives in separate collections: products store a
\`supplier_id\` that points at a document in \`suppliers\`. A **join** combines them by
matching rows on a condition. An **inner join** returns only the pairs that match;
give each collection an alias (\`p\`, \`s\`) to say which fields you mean.`,
    sql: "Same as SQL INNER JOIN … ON.",
    syntax: [
      "SELECT a.field, b.field AS other",
      "FROM collection_a AS a INNER JOIN collection_b AS b ON a.key = b._id",
    ],
    task: "Show each product's name together with the name of its supplier.",
    hint: "Each product has a `supplier_id`; match it to the supplier's `_id`.",
    answer:
      "SELECT p.name, s.name AS supplier FROM products AS p INNER JOIN suppliers AS s ON p.supplier_id = s._id",
    check: ({ rows }) => {
      const values = allValues(rows);
      if (!values.includes("Andes Roasters")) return fail("Include the supplier's name.");
      if (!values.includes("Coffee beans")) return fail("Include the product's name.");
      return rows.length === 5
        ? pass
        : fail(
            `An inner join returns 5 rows here (one product's supplier doesn't exist) — got ${rows.length}.`,
          );
    },
    success: "Only 5 rows: the Travel mug points at supplier s4, which doesn't exist.",
  },
  {
    level: "advanced",
    title: "Outer joins",
    concept: `A **left (outer) join** keeps every row from the left collection, even when nothing
matches on the right; the right side's fields are then missing. Filtering for
that missing side finds orphans — an **anti-join**.`,
    sql: "Same as SQL LEFT JOIN; DQL tests the unmatched side with IS MISSING.",
    syntax: [
      "SELECT … FROM a LEFT JOIN b ON a.key = b._id   -- keeps every row of a",
      "-- rows of a with no match have b's fields MISSING",
    ],
    task: "Find the products whose supplier doesn't exist, and show their names.",
    hint: "LEFT JOIN products to suppliers, then keep the rows where the supplier's `_id` IS MISSING.",
    answer:
      "SELECT p.name FROM products AS p LEFT JOIN suppliers AS s ON p.supplier_id = s._id WHERE s._id IS MISSING",
    check: ({ rows }) => expectProducts(rows, ["Travel mug"]),
    success: "Anti-joins are a quick data-quality check for broken references.",
  },
  {
    level: "advanced",
    title: "Conditions on array elements: ANY … SATISFIES",
    concept: `\`array_contains\` tests for a simple value, but arrays often hold objects — like
the \`lines\` of an order, each with a \`sku\` and a \`qty\`. A **quantified predicate**
tests the elements one at a time: \`ANY l IN lines SATISFIES <condition> END\` is
true when at least one element meets the whole condition. (\`EVERY … SATISFIES\`
requires all of them.) The \`orders\` collection has three orders.`,
    sql: "Like an EXISTS subquery over a child table, written inline.",
    syntax: [
      "SELECT _id FROM orders WHERE ANY l IN lines SATISFIES l.sku = 'p3' END",
      "… SATISFIES l.sku = 'p5' AND l.qty > 1 END   -- both on the same element",
    ],
    task: "Find the orders that have a line for product 'p1' with a quantity of exactly 2, and show their `_id`.",
    hint: "Put both conditions, on `l.sku` and on `l.qty`, inside one SATISFIES with AND.",
    answer: "SELECT _id FROM orders WHERE ANY l IN lines SATISFIES l.sku = 'p1' AND l.qty = 2 END",
    check: ({ rows }) => {
      const ids = rows.map((r) => r._id);
      if (ids.some((id) => typeof id !== "string")) return fail("Include the orders' `_id`.");
      return sameSet(ids, ["o1"])
        ? pass
        : fail(
            `Only o1 has a single line with 2 × p1 — got ${ids.join(", ") || "none"}. Both conditions must hold for the same line.`,
          );
    },
    success:
      "Order o2 also contains p1, but with quantity 1 — SATISFIES checks both conditions on each line together.",
    newIn:
      "SDK 5.2 fixed `AND` inside SATISFIES; 5.1 ignored part of the condition and also returned o2.",
  },
  {
    level: "advanced",
    title: "Indexes",
    concept: `Without an **index**, a filter has to read every document in the collection (a
**scan**). An index is a sorted lookup structure on one or more fields — like the
index at the back of a book — so matching documents can be found directly. Indexes
speed up reads but take space and make writes slightly slower, so add them for the
queries you run often.`,
    sql: "Same idea as SQL CREATE INDEX.",
    syntax: [
      "CREATE INDEX IF NOT EXISTS name ON collection (field)",
      "SELECT * FROM system:indexes",
    ],
    task: `Create an index named \`${PRACTICE_INDEX}\` on the \`category\` field of \`products\`.`,
    hint: "`CREATE INDEX IF NOT EXISTS <name> ON <collection> (<field>)`.",
    answer: `CREATE INDEX IF NOT EXISTS ${PRACTICE_INDEX} ON products (category)`,
    setup: [`DROP INDEX IF EXISTS ${PRACTICE_INDEX} ON products`],
    check: async ({ query }) => {
      const rows = await query("SELECT * FROM system:indexes");
      const found = rows.some(
        (r) => r.collection === "products" && JSON.stringify(r.fields ?? "").includes('"category"'),
      );
      return found ? pass : fail("No index on `products.category` yet.");
    },
    success:
      "`system:indexes` is a virtual collection: you query the database's own metadata with DQL.",
  },
  {
    level: "advanced",
    title: "Composite indexes and sort order",
    concept: `A **composite index** covers several fields, in order, and each key can have its
own direction. An index on \`(category ASC, price DESC)\` keeps products grouped by
category with the most expensive first — so a query that sorts the same way can
read results straight from the index instead of sorting them.`,
    sql: "Same as a multi-column SQL index with per-column ASC/DESC.",
    syntax: [
      "CREATE INDEX IF NOT EXISTS idx_name ON collection (field_a ASC, field_b DESC)",
      "SELECT … ORDER BY field_a ASC, field_b DESC   -- matches the index",
    ],
    task: `Create the index \`${COMPOSITE_INDEX}\` on \`(category ASC, price DESC)\`. Then list the products sorted by category, with the most expensive first within each category.`,
    hint: "Two statements: CREATE INDEX on `(category ASC, price DESC)`, then a SELECT whose ORDER BY matches it.",
    answer: "SELECT name, category, price FROM products ORDER BY category ASC, price DESC",
    setup: [`CREATE INDEX IF NOT EXISTS ${COMPOSITE_INDEX} ON products (category ASC, price DESC)`],
    check: async ({ rows, kind, query }) => {
      const indexes = await query("SELECT * FROM system:indexes");
      if (!indexes.some((r) => String(r._id).endsWith(COMPOSITE_INDEX))) {
        return fail(`Create the index \`${COMPOSITE_INDEX}\` first.`);
      }
      if (kind !== "select")
        return fail("Now run the SELECT with `ORDER BY category ASC, price DESC`.");
      const names = productNames(rows);
      if (!names) return fail("Include the `name` field.");
      const expected = [
        "Travel mug",
        "Espresso blend",
        "Coffee beans",
        "Paper filters",
        "Green tea",
        "Chai spices",
      ];
      return names.join("|") === expected.join("|")
        ? pass
        : fail(`Expected: ${expected.join(", ")}.`);
    },
    success: "Run it with EXPLAIN to see the indexScan feeding the results in order.",
    newIn: "SDK 5.2 fixed ordering for indexes that mix ASC and DESC keys.",
  },
  {
    level: "advanced",
    title: "Reading query plans with EXPLAIN",
    concept: `Before running a query, Ditto's **planner** decides how to execute it: which
index to use, in what order to filter, sort, and project. \`EXPLAIN\` shows that
plan as a tree of **operators** without running the query. Look for \`indexScan\`
(uses an index) versus \`scan\` (reads every document).`,
    sql: "Like SQL EXPLAIN.",
    syntax: ["EXPLAIN SELECT name FROM products WHERE price > 10"],
    task: "Use EXPLAIN on a query that finds the products in the `tea` category, and check that the plan uses your index.",
    hint: "Put `EXPLAIN` in front of a SELECT that filters on `category`.",
    answer: "EXPLAIN SELECT name FROM products WHERE category = 'tea'",
    setup: [`CREATE INDEX IF NOT EXISTS ${PRACTICE_INDEX} ON products (category)`],
    check: ({ kind, rows }) => {
      if (kind !== "explain") return fail("Start the statement with `EXPLAIN`.");
      const plan = JSON.stringify(rows);
      return plan.includes("indexScan")
        ? pass
        : fail("This plan doesn't use the index — filter on `category`.");
    },
    success: "Try EXPLAIN on `WHERE price > 10`: with no index on price, you'll see a full `scan`.",
  },
  {
    level: "advanced",
    title: "Measuring with PROFILE",
    concept: `\`EXPLAIN\` shows the plan; \`PROFILE\` **runs** the query and measures each operator:
how many documents went in and out, CPU time, time waiting on storage (\`stor\`), and
how often it yielded to the scheduler. The slowest operator is the one to optimize.`,
    sql: "Like EXPLAIN ANALYZE in PostgreSQL.",
    syntax: ["PROFILE SELECT name FROM products WHERE category = 'tea'"],
    task: "Use PROFILE on a SELECT that finds the products priced over 10.",
    hint: "Put `PROFILE` in front of a SELECT that filters on `price`.",
    answer: "PROFILE SELECT name FROM products WHERE price > 10",
    check: ({ kind, rows }) => {
      if (kind !== "profile") return fail("Start the statement with `PROFILE`.");
      return rows.some((r) => "~request_profile" in r)
        ? pass
        : fail("No profile came back — PROFILE works with SELECT statements.");
    },
    success: 'Outside the tutorial, `dittosh dql --profile "SELECT …"` gives the same view.',
  },
  {
    level: "advanced",
    title: "Addressing documents with USE IDS",
    concept: `When you already know the document IDs, \`USE IDS\` targets them directly instead
of evaluating a WHERE predicate: \`UPDATE products USE IDS 'p1', 'p2' SET …\`,
\`EVICT FROM products USE IDS 'p7'\`. It's the cheapest way to touch specific
documents.`,
    syntax: [
      "UPDATE products USE IDS 'p3' SET stock = 40",
      "SELECT name FROM products USE IDS 'p1'",
    ],
    task: "Evict the Cold brew kit (`_id` 'p7') using `USE IDS`.",
    hint: "`EVICT FROM` the collection, then `USE IDS` with the kit's `_id`.",
    answer: "EVICT FROM products USE IDS 'p7'",
    setup: [
      "INSERT INTO products VALUES ({'_id': 'p7', 'name': 'Cold brew kit', 'category': 'coffee', 'price': 25}) ON ID CONFLICT DO UPDATE",
    ],
    check: async ({ statement, query }) => {
      if (!/\bUSE\s+IDS\b/i.test(statement))
        return fail("Use `USE IDS 'p7'` instead of WHERE this time.");
      const rows = await query("SELECT _id FROM products WHERE _id = 'p7'");
      return rows.length === 0 ? pass : fail("p7 is still in the store.");
    },
    success: "USE IDS works with UPDATE, EVICT, and DELETE.",
    newIn: "SDK 5.2 fixed DELETE/EVICT … USE IDS, which silently removed nothing in 5.1.",
  },
  {
    level: "advanced",
    title: "Inspecting the database with system collections",
    concept: `Ditto exposes its own state as **virtual collections** in the \`system:\` namespace,
queryable with ordinary DQL: \`system:indexes\`, \`system:collections\`,
\`system:system_info\` (engine settings and storage facts), \`system:metrics\` (live
counters and timings), and \`system:sync_degradations\` (documents that can't
sync — always empty in this offline CLI).`,
    syntax: [
      "SELECT * FROM system:collections",
      "SELECT DISTINCT namespace FROM system:system_info",
      "SELECT key, current FROM system:metrics WHERE key LIKE 'ditto.query.%'",
    ],
    task: "List the storage-engine keys: the distinct `key` values in `system:system_info` whose `namespace` is 'backend_sqlite3'.",
    hint: "Start from `SELECT DISTINCT key FROM system:system_info` and filter on `namespace`.",
    answer: "SELECT DISTINCT key FROM system:system_info WHERE namespace = 'backend_sqlite3'",
    check: ({ rows }) =>
      allValues(rows).includes("wal_current_size_bytes")
        ? pass
        : fail(
            "Expected keys such as `wal_current_size_bytes` — filter on `namespace = 'backend_sqlite3'`.",
          ),
    success: "In the regular shell, `.metrics` turns `system:metrics` into readable tables.",
    newIn:
      "SDK 5.2 added the WAL and checkpoint keys, `system:sync_degradations`, and `ditto.query.*` metrics.",
  },
];

/** Index of the first lesson at `level`. */
export function firstLessonOf(level: Level, lessons: readonly Lesson[] = LESSONS): number {
  return Math.max(
    0,
    lessons.findIndex((l) => l.level === level),
  );
}
