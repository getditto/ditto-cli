# Manual testing — `dittosh` against the retail-joins dataset

Full-surface checklist for the `dittosh dql` feature set, focused on JOINs.
`retail-joins` is the normalized variant of `retail`: `orders`/
`order_items` are stripped of denormalized fields (`store_name`,
`customer_name`, …) so you must join to get readable results, a
`product_types` table is added (32 fixed rows), ~8% of inventory
(store, product) pairs are dropped and ~1% of customers are reserved with no
orders — deliberate holes for LEFT JOIN anti-join queries.

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off (rendering glitches, wrong
exit codes, noise on stdout) as a comment under the failing test.

Sibling file: `testing-dql-retail.md` covers the same feature surface
against the denormalized `retail` dataset (no JOINs needed).

Prereq: the release build is installed (`scripts/install-release.sh`).

Two things that are **not** bugs:

- The ~7 `warning:`/`INFO` lines at startup are the SDK's native tracing
  bootstrap writing to **stderr** (fd-level, not suppressible from JS).
  stdout — everything you pipe — stays clean.
- Piped stdout is always **JSON**, never the table. The table (and the
  pager) only appear when stdout is a terminal.

Anchor rows to know (deterministic, present at any scale):

- Customer **Jordan Anchor** — `_id`/`customer_id`
  `d30977d3-fa5d-4e13-9175-f637bccc4c87`, email `jordan.anchor@example.net`,
  home store `store_seattle`.
- His three Seattle orders — `order_20221209_0001`, `order_20230110_0001`,
  `order_20230615_0001` — each 2 items, `total` 164.25.

## 1. Setup

- [ ] **Start from a clean store** (destroys any existing local store —
  e.g. the retail one from the sibling checklist)
  ```bash
  dittosh dql delete-store -y
  ```
  Expect: `Deleted the store at …` (or `No store at … — nothing to delete.`).

- [ ] **Inspect the retail-joins suite**
  ```bash
  dittosh dql dataset show retail-joins
  ```
  Expect: 8 collections (stores, categories, product_types, products,
  customers, inventory, orders, order_items), scaling dimension `orders`,
  default 5,000, 96 catalog queries, and a known-issues note about
  `joins__left__products_inventory_stock_value`.

- [ ] **Load it**
  ```bash
  dittosh dql dataset load retail-joins
  ```
  Expect: progress on **stderr**, a clean summary table; exits 0.

- [ ] **Sanity counts**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM orders"
  dittosh dql "SELECT count(*) AS n FROM product_types"
  dittosh dql "SELECT count(*) AS n FROM products"
  dittosh dql "SELECT count(*) AS n FROM customers"
  ```
  Expect (piped → JSON): `5000`, `32`, `400`, `1251`.

- [ ] **Normalization proof — the denormalized fields are gone**
  ```bash
  dittosh dql "SELECT * FROM orders LIMIT 1"
  ```
  Expect: 10 fields only (`_id`, `customer_id`, `deleted`, `item_count`,
  `order_date`, `order_id`, `status`, `store_id`, `subtotal`, `total`) — no
  `store_name`/`customer_name`/`customer_email`. To see a store name you
  must join for it.

## 2. Joins that work without indexes (small right-hand side)

Joining to a *small* collection (stores: 8, product_types: 32, products:
400) needs no index. Joining to a large one does — that's section 3.

- [ ] **Inner join: the anchor order's store**
  ```bash
  dittosh dql "SELECT o._id, o.total, s.store_name, s.location.city
    FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id
    WHERE o._id = 'order_20221209_0001'"
  ```
  Expect: 1 row — `order_20221209_0001`, 164.25, `Zava Retail Seattle`,
  `Seattle`.

- [ ] **Inner join: the anchor order's line items**
  ```bash
  dittosh dql "SELECT i._id, i.quantity, p.product_name, p.base_price
    FROM order_items AS i INNER JOIN products AS p ON i.product_id = p._id
    WHERE i.order_id = 'order_20221209_0001'"
  ```
  Expect: 2 rows — `HND item 0001` (52.07) and `HND item 0002` (69.66).

- [ ] **Three-way join: Jordan Anchor's order history**
  ```bash
  dittosh dql "SELECT o._id, o.total, c.last_name, s.store_name
    FROM orders AS o
    INNER JOIN customers AS c ON c._id = o.customer_id
    INNER JOIN stores AS s ON s._id = o.store_id
    WHERE o.customer_id = 'd30977d3-fa5d-4e13-9175-f637bccc4c87'"
  ```
  Expect: 3 rows, one per anchor order — `Anchor`, `Zava Retail Seattle`,
  164.25 each.

- [ ] **Join with the new product_types table**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM products AS p INNER JOIN product_types AS t ON p.type_id = t._id WHERE p.deleted = false"
  ```
  Expect: `[{"n":400}]` — every product has a type.

- [ ] **Customers and their home stores**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM customers AS c INNER JOIN stores AS s ON c.primary_store_id = s._id WHERE c.deleted = false"
  ```
  Expect: `[{"n":1251}]`.

## 3. Joins to large collections need indexes (the ADVISE story)

Joining to a large collection without an index on the join predicate is a
hard error — and the error itself tells you what to do next.

- [ ] **A LEFT JOIN against orders fails clean**
  ```bash
  dittosh dql "SELECT c._id, c.first_name, c.last_name FROM customers AS c
    LEFT OUTER JOIN orders AS o ON o.customer_id = c._id
    WHERE o._id IS MISSING AND c.deleted = false" ; echo "exit: $?"
  ```
  Expect: `Query error [query/evaluation]: Query failed: ` + "`Joining to
  "o" disallowed without appropriate index support. Please run ADVISE for
  recommendations.`", `exit: 1`.

- [ ] **ADVISE reads the join and recommends both indexes**
  ```bash
  dittosh dql "SELECT c._id, c.first_name, c.last_name FROM customers AS c
    LEFT OUTER JOIN orders AS o ON o.customer_id = c._id
    WHERE o._id IS MISSING AND c.deleted = false" --advise
  ```
  Expect: two suggestions —
  `customers — equality predicates on deleted` and
  `orders — equality predicates on customer_id; supports join` —
  plus the copy-pasteable `apply with:` line carrying the full statement.

- [ ] **Apply them**
  ```bash
  dittosh dql "SELECT c._id, c.first_name, c.last_name FROM customers AS c
    LEFT OUTER JOIN orders AS o ON o.customer_id = c._id
    WHERE o._id IS MISSING AND c.deleted = false" --advise --apply -y
  ```
  Expect: both suggestions badge `✓ created`
  (`adv_customers_deleted`, `adv_orders_customer_id`).

- [ ] **Re-run: the anti-join finds the reserved customers**
  ```bash
  dittosh dql "SELECT c._id, c.first_name, c.last_name FROM customers AS c
    LEFT OUTER JOIN orders AS o ON o.customer_id = c._id
    WHERE o._id IS MISSING AND c.deleted = false"
  ```
  Expect: **25 rows** — the ~1% of customers the generator deliberately
  never gave orders.

- [ ] **EXPLAIN shows the nested-loop join over the new index**
  ```bash
  dittosh dql "SELECT c._id FROM customers AS c LEFT OUTER JOIN orders AS o ON o.customer_id = c._id WHERE o._id IS MISSING AND c.deleted = false" --explain
  ```
  Expect: `indexScan` on `adv_customers_deleted`, then an
  `nlJoin … outer=true` whose inner side is a covering `indexScan` on
  `adv_orders_customer_id`, then the `IS MISSING` filter.

- [ ] **Per-store order counts (LEFT JOIN with GROUP BY)**
  ```bash
  dittosh dql "SELECT s.store_name, COUNT(o._id) AS order_count
    FROM stores AS s LEFT OUTER JOIN orders AS o ON o.store_id = s._id
    WHERE s.deleted = false GROUP BY s._id, s.store_name ORDER BY s.store_name" --advise --apply -y
  ```
  Expect: on the first run, ADVISE creates `adv_stores_deleted` and
  `adv_orders_store_id`; re-run the same statement without the flags and
  you get **8 rows** — Zava Online 1268, Bellevue 418, Olympia 448,
  Redmond 384, Seattle 1259, Spokane 425, Tacoma 407, Vancouver 391
  (sums to 5,000).

- [ ] **Inventory holes at one store (AND in the ON clause)**
  ```bash
  dittosh dql "SELECT p._id, p.product_name FROM products AS p
    LEFT OUTER JOIN inventory AS i ON i.product_id = p._id AND i.store_id = 'store_seattle'
    WHERE i._id IS MISSING" --advise --apply -y
  ```
  Expect: ADVISE creates a *composite* index
  `adv_inventory_product_id_store_id ON inventory (product_id ASC, store_id ASC)`
  — one per ON predicate. Re-run without the flags: **24 rows** — the ~8%
  of (store, product) inventory pairs the generator drops.

## 4. Aggregates over joins

- [ ] **Sales by store by month** (verbatim catalog query)
  ```bash
  dittosh dql "SELECT s.store_name, substr(o.order_date, 1, 7) AS month, SUM(o.total) AS total
    FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id
    GROUP BY s.store_name, substr(o.order_date, 1, 7) ORDER BY s.store_name, month"
  ```
  Expect: **248 rows** (8 stores × ~31 months).

- [ ] **Big spenders (HAVING)**
  ```bash
  dittosh dql "SELECT c._id FROM orders AS o INNER JOIN customers AS c ON o.customer_id = c._id
    GROUP BY c._id HAVING SUM(o.total) > 5000"
  ```
  Expect: **202 rows** (works without an index — customers is small).

## 5. The catalog runner

- [ ] **Run a catalog join by name, with its index setup**
  ```bash
  dittosh dql dataset run items__join__products --dataset retail-joins --setup
  ```
  Expect: `Running items__join__products (retail-joins):`, the query text,
  the setup DDL (`DROP INDEX IF EXISTS items_product…` / `CREATE INDEX
  items_product…`) each acked `OK`, then the 2 anchor line items.
  postQueries (teardown) never run — created indexes are kept.

- [ ] **Known issue, do not demo**: `joins__left__products_inventory_stock_value`
  hangs (nlJoin over intersectScan) on SDK 5.1.0 when its `inv_store_flat`
  index exists. If you try it, run it *without* `--setup`, or add `LIMIT`.

## 6. Housekeeping commands

- [ ] **Doctor**
  ```bash
  dittosh dql doctor
  ```
  Expect: six `✓` lines — platform, node, data directory, token, sdk, lock.

- [ ] **Version**
  ```bash
  dittosh version
  dittosh version --format json | jq '.ditto_sdk'
  ```
  Expect: aligned key/value list; the JSON form reports `"5.1.0"`.

- [ ] **Collections**
  ```bash
  dittosh dql collections
  ```
  Expect: the 8 retail-joins collections plus the `__feature_flags` system
  collection.

- [ ] **Indexes — the ones you created in section 3**
  ```bash
  dittosh dql indexes
  dittosh dql indexes orders
  ```
  Expect: the `adv_*` indexes (`adv_customers_deleted`,
  `adv_orders_customer_id`, `adv_stores_deleted`, `adv_orders_store_id`,
  `adv_inventory_product_id_store_id`, maybe `items_product` from section
  5); the second command filters to `orders` only.

- [ ] **Update check** (optional — hits the network)
  ```bash
  dittosh update --check
  ```
  Expect: "Already up to date" or "Update available: …".

- [ ] **Skills list** (optional, read-only)
  ```bash
  dittosh skills list
  ```
  Expect: a table of AI agents and whether the DQL skill is installed.

- [ ] **Global flags: colors off**
  ```bash
  dittosh dql "SELECT * FROM product_types" --no-color
  ```
  Expect: the table renders with zero ANSI color escapes.

## 7. Statement input modes

- [ ] **`-e/--execute` form**
  ```bash
  dittosh dql -e "SELECT count(*) AS n FROM product_types"
  ```
  Expect: `[{"n":32}]`.

- [ ] **Batch from a file**
  ```bash
  printf "SELECT count(*) AS n FROM stores;\nSELECT count(*) AS n FROM product_types;\n" > /tmp/mtj-batch.sql
  dittosh dql -f /tmp/mtj-batch.sql
  ```
  Expect: two JSON arrays (`8` then `32`), summary `2 ok, 0 failed (of 2)`
  on stderr.

- [ ] **Batch from stdin + `--continue-on-error`**
  ```bash
  printf "SELECT count(*) AS n FROM stores;\nSELEC broken;\nSELECT count(*) AS n FROM categories;\n" | dittosh dql --continue-on-error ; echo "exit: $?"
  ```
  Expect: the two good results on stdout, `Query error [query/invalid]` on
  stderr, summary `2 ok, 1 failed (of 3)`, `exit: 1`.

- [ ] **REPL dot-commands are stripped from batches**
  ```bash
  printf ".exit\nSELECT count(*) AS n FROM stores;\n" | dittosh dql
  ```
  Expect: stderr note `skipping REPL command in batch input: .exit`, then
  the result — a batch never exits mid-stream.

- [ ] **`-p/--param` binding, into a join**
  ```bash
  dittosh dql "SELECT c.first_name, c.last_name, s.store_name
    FROM customers AS c INNER JOIN stores AS s ON c.primary_store_id = s._id
    WHERE c._id = :cid" -p cid=d30977d3-fa5d-4e13-9175-f637bccc4c87
  ```
  Expect: one row — `Jordan`, `Anchor`, `Zava Retail Seattle`.

- [ ] **`--args` inline JSON**
  ```bash
  dittosh dql "SELECT o._id, o.total FROM orders AS o WHERE o.customer_id = :cid ORDER BY o._id" --args '{"cid":"d30977d3-fa5d-4e13-9175-f637bccc4c87"}'
  ```
  Expect: the 3 anchor orders, 164.25 each.

- [ ] **Multiple statements in argv are refused**
  ```bash
  dittosh dql "SELECT * FROM stores; SELECT * FROM categories" ; echo "exit: $?"
  ```
  Expect: `trailing text after the statement is not executable…`,
  `exit: 2`.

## 8. Table display on a TTY

- [ ] **Join results fit the window**
  ```bash
  dittosh dql "SELECT o._id, o.order_date, o.total, c.first_name, c.last_name, c.email
    FROM orders AS o INNER JOIN customers AS c ON c._id = o.customer_id LIMIT 5"
  ```
  Expect: the table is exactly your terminal width — no wrapping. Long
  values (emails, UUIDs) end with `…`. `total` right-aligns. `5 rows`
  footer.

- [ ] **Aggregate result columns**
  ```bash
  dittosh dql "SELECT s.store_name, COUNT(o._id) AS order_count
    FROM stores AS s LEFT OUTER JOIN orders AS o ON o.store_id = s._id
    WHERE s.deleted = false GROUP BY s._id, s.store_name ORDER BY s.store_name"
  ```
  Expect: 8 rows, generous column widths, counts right-aligned.

- [ ] **Resize resilience** — re-run the first query in a ~60-col window.
  Expect: still fits, headers ellipsize rather than breaking layout.

## 9. Pager

- [ ] **Long results page**
  ```bash
  dittosh dql "SELECT * FROM orders"
  ```
  Expect: opens in `less` (5,000 rows). `q` quits.

- [ ] **Opt-out flag**
  ```bash
  dittosh dql "SELECT * FROM orders" --no-pager | wc -l
  ```
  Expect: `60002` — normalized orders have 10 fields (12 JSON lines each),
  so 5,000 × 12 + 2 bracket lines. (Denormalized retail orders: 75,002.)

- [ ] **Opt-out env var**
  ```bash
  DITTOSH_NO_PAGER=1 dittosh dql "SELECT * FROM orders" | wc -l
  ```
  Expect: same — `60002`, no pager.

- [ ] **Short results never page**
  ```bash
  dittosh dql "SELECT * FROM product_types"
  ```
  Expect: prints inline (32 rows), no pager flash.

## 10. Output formats & export

- [ ] **Vertical mode: a joined row as a record block**
  ```bash
  dittosh dql "SELECT o._id, o.total, s.store_name, s.location.city, s.location.state
    FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id
    WHERE o._id = 'order_20221209_0001'" --format vertical
  ```
  Expect: one `── row 1 ──` block, `field │ value` lines, nothing
  truncated.

- [ ] **Markdown to stdout**
  ```bash
  dittosh dql "SELECT type_name, category_id FROM product_types WHERE category_id = 'cat_paint'" --format markdown
  ```
  Expect: a GFM table of the 4 paint types.

- [ ] **Markdown to file (extension inference)**
  ```bash
  dittosh dql "SELECT * FROM products WHERE base_price > 500" -o /tmp/expensive.md
  ```
  Expect: `Wrote 12 rows … (markdown)`.

- [ ] **HTML report of a join**
  ```bash
  dittosh dql "SELECT o._id, o.order_date, o.total, c.first_name, c.last_name, s.store_name
    FROM orders AS o
    INNER JOIN customers AS c ON c._id = o.customer_id
    INNER JOIN stores AS s ON s._id = o.store_id
    WHERE o.customer_id = 'd30977d3-fa5d-4e13-9175-f637bccc4c87'" -o /tmp/anchor-orders.html
  open /tmp/anchor-orders.html
  ```
  Expect: `Wrote 3 rows … (html)`; styled table, no external assets.

- [ ] **JSON and CSV to file**
  ```bash
  dittosh dql "SELECT * FROM product_types" -o /tmp/types.json
  dittosh dql "SELECT * FROM product_types" -o /tmp/types.csv
  ```
  Expect: valid JSON array (32 entries) / RFC-4180 CSV with header row.

- [ ] **Files keep full fidelity** (no `…` truncation)
  ```bash
  dittosh dql "SELECT * FROM orders LIMIT 5" -o /tmp/orders.txt
  ```
  Expect: a plain table with complete values — ellipsization is TTY-only.

- [ ] **Explicit format beats extension**
  ```bash
  dittosh dql "SELECT * FROM product_types" -o /tmp/types.txt --format csv
  ```
  Expect: CSV content in a `.txt` file.

- [ ] **`-o` rejected for mutations/DDL**
  ```bash
  dittosh dql "INSERT INTO stores DOCUMENTS ({'_id':'x'})" -o /tmp/nope.json ; echo "exit: $?"
  ```
  Expect: `-o/--out only applies to row-producing statements…`, `exit: 2`.

## 11. Safety rails

- [ ] **No-LIMIT heads-up** (once per config dir, TTY stderr only)
  ```bash
  DITTOSH_CONFIG_DIR=/tmp/mtj-fresh-config dittosh dql "SELECT * FROM product_types"
  ```
  Expect, before the table: `heads up: this SELECT has no LIMIT — …
  (shown once)`. Re-run: no warning.

- [ ] **`--max-rows` truncates with a warning**
  ```bash
  dittosh dql "SELECT * FROM product_types" --max-rows 3
  ```
  Expect: 3 rows, and on stderr: `showing first 3 of 32 rows — add a LIMIT
  clause`.

## 12. Import external data (`dql import`)

The standard import format is a **JSON array of objects**; NDJSON (one
object per line) is also accepted. `_id` is optional — docs without one get
a generated UUID. Imports upsert (`ON ID CONFLICT DO UPDATE`), so files
*with* `_id`s re-import cleanly; files *without* duplicate on re-import.

- [ ] **Import a JSON array**
  ```bash
  cat > /tmp/import-j.json <<'EOF'
  [
    { "_id": "imp_1", "type_name": "Imported Widget", "category_id": "cat_hardware" },
    { "_id": "imp_2", "type_name": "Imported Gizmo", "category_id": "cat_electrical" }
  ]
  EOF
  dittosh dql import /tmp/import-j.json imported_types
  dittosh dql "SELECT * FROM imported_types ORDER BY _id"
  ```
  Expect: `Imported 2 documents into imported_types (…s)`; the 2 docs read
  back intact.

- [ ] **Re-import is idempotent**
  ```bash
  dittosh dql import /tmp/import-j.json imported_types
  dittosh dql "SELECT count(*) AS n FROM imported_types"
  ```
  Expect: still `[{"n":2}]`.

- [ ] **Docs without `_id` get a generated UUID**
  ```bash
  echo '[{"name": "no id here"}]' > /tmp/noid.json
  dittosh dql import /tmp/noid.json imported_misc
  dittosh dql "SELECT _id, name FROM imported_misc"
  ```
  Expect: the doc carries a UUID `_id`.

- [ ] **NDJSON works too**
  ```bash
  printf '{"_id":"n1","v":1}\n{"_id":"n2","v":2}\n' > /tmp/import.ndjson
  dittosh dql import /tmp/import.ndjson imported_nd
  ```
  Expect: `Imported 2 documents into imported_nd`.

- [ ] **Bad inputs exit 2, nothing written**
  ```bash
  dittosh dql import /tmp/missing.json things ; echo "exit: $?"
  echo 'not json' > /tmp/bad.json && dittosh dql import /tmp/bad.json things ; echo "exit: $?"
  dittosh dql import /tmp/import-j.json "bad;name" ; echo "exit: $?"
  ```
  Expect: clear messages, all `exit: 2`.

## 13. jq pipelines

- [ ] **Join → jq**
  ```bash
  dittosh dql "SELECT o._id, o.total, s.store_name FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id WHERE o._id = 'order_20221209_0001'" | jq '.[0].store_name'
  ```
  Expect: `"Zava Retail Seattle"` — jq parses cleanly (stdout is pure
  JSON).

- [ ] **Full round trip: query → jq → query**
  ```bash
  dittosh dql "SELECT _id FROM customers WHERE email = 'jordan.anchor@example.net'" \
    | jq '{cid: .[0]._id}' \
    | dittosh dql "SELECT o._id, o.total FROM orders AS o WHERE o.customer_id = :cid ORDER BY o._id" --args -
  ```
  Expect: the 3 anchor orders, exit 0.

- [ ] **Params from a file**
  ```bash
  echo '{"cid": "d30977d3-fa5d-4e13-9175-f637bccc4c87"}' > /tmp/params-j.json
  dittosh dql "SELECT first_name, last_name FROM customers WHERE _id = :cid" --args @/tmp/params-j.json
  ```
  Expect: the Jordan Anchor row.

- [ ] **`-p` overrides `--args`**
  ```bash
  dittosh dql "SELECT store_name FROM stores WHERE location.city = :city" --args '{"city":"Bellevue"}' -p city=Tacoma
  ```
  Expect: the Tacoma store, not Bellevue.

- [ ] **Bad pipeline input fails clean**
  ```bash
  echo '[1,2]' | dittosh dql "SELECT * FROM stores" --args - ; echo "exit: $?"
  ```
  Expect: `--args must be a JSON object` on stderr, `exit: 2`.

## 14. REPL (interactive shell)

- [ ] **Start it**
  ```bash
  dittosh dql
  ```
  Expect: `dql>` prompt.

- [ ] **In the shell (joins work here too):**
  ```sql
  SELECT * FROM product_types;
  SELECT o._id, o.total, s.store_name FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id WHERE o._id = 'order_20221209_0001';
  .collections
  .indexes orders
  .help
  ```
  Expect: fitted tables, a dim `(N ms)` timing note after every statement
  (always on in the shell — no flag needed), listings, help. Long results
  page through less.

- [ ] **Multi-line statement**
  ```sql
  SELECT c.first_name, c.last_name, s.store_name
  FROM customers AS c
  INNER JOIN stores AS s ON c.primary_store_id = s._id
  WHERE c._id = 'd30977d3-fa5d-4e13-9175-f637bccc4c87';
  ```
  Expect: continuation prompt until the `;`, then the Jordan Anchor row.

- [ ] **Discard a half-typed statement** — start a multi-line statement,
  then `.break` at the continuation prompt. Expect: buffer discarded,
  nothing executed.

- [ ] **Exit** with `.exit` — expect a clean return to your shell.

## 15. Diagnostics (`--time` / `--explain` / `--profile` / `--advise`)

- [ ] **Timing footer on a join**
  ```bash
  dittosh dql "SELECT o._id, s.store_name FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id WHERE o._id = 'order_20221209_0001'" --time
  ```
  Expect: the row, then a dim `Time: N ms` footer on **stderr**.

- [ ] **stdout stays clean (jq composability)**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM orders" --time | jq '.[0].n'
  ```
  Expect: `5000` — timing on stderr, pure JSON on stdout.

- [ ] **Server breakdown with --profile**
  ```bash
  dittosh dql "SELECT c._id FROM orders AS o INNER JOIN customers AS c ON o.customer_id = c._id GROUP BY c._id HAVING SUM(o.total) > 5000" --time --profile
  ```
  Expect: the footer gains server-side timings —
  `Time: N ms — server: elapsed … · parse … · plan …`.

- [ ] **Profile a join aggregate**
  ```bash
  dittosh dql "SELECT c._id FROM orders AS o INNER JOIN customers AS c ON o.customer_id = c._id GROUP BY c._id HAVING SUM(o.total) > 5000" --profile
  ```
  Expect: per-operator timings — `scan collection=orders · 5000 out`, an
  `nlJoin … · 5000 in / 5000 out`, `▲ HOT` on the `groupBy` (`5000 in /
  1226 out`), `filter` down to `202`, and a `Results 202` summary.

- [ ] **Per-statement timing in a batch**
  ```bash
  printf "SELECT count(*) FROM orders;\nSELECT count(*) FROM product_types;\n" | dittosh dql --time
  ```
  Expect: one `Time: N ms` footer per statement, then the
  `2 ok, 0 failed (of 2)` summary — all on stderr.

- [ ] **EXPLAIN/ADVISE on joins** — covered where they're interesting:
  section 3 (index requirement, `nlJoin` plans, multi-index advice).

## 16. Exit codes & locking

- [ ] **Query error → 1**
  ```bash
  dittosh dql "SELEC broken" ; echo "exit: $?"
  ```

- [ ] **Missing join index → 1** (the section 3 error, before ADVISE is
  applied — or after `delete-store` + reload)

- [ ] **Usage error → 2**
  ```bash
  dittosh dql "SELECT * FROM stores" --format yaml ; echo "exit: $?"
  ```

- [ ] **Success → 0**
  ```bash
  dittosh dql "SELECT * FROM product_types LIMIT 1" > /dev/null ; echo "exit: $?"
  ```

- [ ] **Lock → 4** (optional, two terminals): start the REPL in one
  terminal (`dittosh dql`), then in another:
  ```bash
  dittosh dql "SELECT * FROM stores LIMIT 1" ; echo "exit: $?"
  ```
  Expect: a "in use by another dittosh process" message, `exit: 4`.
  `.exit` the REPL and re-run — succeeds.

## 17. Cleanup

- [ ] **Delete the store when done**
  ```bash
  dittosh dql delete-store -y
  ```
