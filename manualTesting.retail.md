# Manual testing — `dittosh` against the retail dataset

Full-surface checklist for the `dittosh dql` feature set. Every command is
copy-pasteable and uses the default data dir. Run top to bottom; check off
what passes. Note anything off (rendering glitches, wrong exit codes, noise
on stdout) as a comment under the failing test.

Sibling file: `manualTesting.retail-joins.md` covers the same surface against
the normalized `retail-joins` dataset (JOINs, anti-joins, join indexes).

Prereq: the release build is installed (`scripts/install-release.sh`).

Two things that are **not** bugs:

- The ~7 `warning:`/`INFO` lines at startup are the SDK's native tracing
  bootstrap writing to **stderr** (fd-level, not suppressible from JS).
  stdout — everything you pipe — stays clean.
- Piped stdout is always **JSON**, never the table. The table (and the
  pager) only appear when stdout is a terminal.

## 1. Setup

- [ ] **Start from a clean store** (destroys any existing local store)
  ```bash
  dittosh dql delete-store -y
  ```
  Expect: `Deleted the store at …` (or `No store at … — nothing to delete.`).

- [ ] **List datasets**
  ```bash
  dittosh dql dataset list
  ```
  Expect (piped → JSON): `movies` (1 collection, 49 queries), `retail` (7,
  72), `retail-joins` (8, 96), `pos` (3, 44).

- [ ] **Inspect the retail suite**
  ```bash
  dittosh dql dataset show retail
  ```
  Expect: 7 collections (stores, categories, products, customers, inventory,
  orders, order_items), scaling dimension `orders`, default 5,000.

- [ ] **Load it**
  ```bash
  dittosh dql dataset load retail
  ```
  Expect: progress on **stderr**, a clean summary table; exits 0.

- [ ] **Sanity counts**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM orders"
  dittosh dql "SELECT count(*) AS n FROM customers"
  ```
  Expect (piped → JSON): `[{"n":5000}]`, then `[{"n":1251}]`.

## 2. Housekeeping commands

- [ ] **Doctor**
  ```bash
  dittosh dql doctor
  ```
  Expect: six `✓` lines — platform, node, data directory, token, sdk, lock.
  Exit 0.

- [ ] **Version**
  ```bash
  dittosh version
  dittosh version --format json | jq '.ditto_sdk'
  ```
  Expect: aligned key/value list (version, SDK, channel, token expiry,
  paths); the JSON form parses and reports `"5.1.0"`.

- [ ] **Collections**
  ```bash
  dittosh dql collections
  ```
  Expect: the 7 retail collections plus the `__feature_flags` system
  collection.

- [ ] **Indexes (none yet)**
  ```bash
  dittosh dql indexes
  ```
  Expect: `[]` — `dataset load` never creates indexes. (If you already ran
  the demo flow in section 13, you'll see the `adv_*` indexes instead.)

- [ ] **Update check** (optional — hits the network)
  ```bash
  dittosh update --check
  ```
  Expect: "Already up to date" or "Update available: …" with upgrade
  instructions on stderr.

- [ ] **Skills list** (optional, read-only)
  ```bash
  dittosh skills list
  ```
  Expect: a table of AI agents and whether the DQL skill is installed.
  (`skills add` writes into agent config dirs — deliberately not exercised
  here.)

- [ ] **Global flags: colors off**
  ```bash
  dittosh dql "SELECT * FROM categories" --no-color
  ```
  Expect: the table renders with box-drawing characters but zero ANSI color
  escapes (compare against a colored run on a TTY).

## 3. Statement input modes

- [ ] **Positional statement** — every command above uses it.

- [ ] **`-e/--execute` form**
  ```bash
  dittosh dql -e "SELECT count(*) AS n FROM stores"
  ```
  Expect: `[{"n":8}]`.

- [ ] **Batch from a file**
  ```bash
  printf "SELECT count(*) AS n FROM stores;\nSELECT count(*) AS n FROM categories;\n" > /tmp/mt-batch.sql
  dittosh dql -f /tmp/mt-batch.sql
  ```
  Expect: two JSON arrays (`8` then `9`), summary `2 ok, 0 failed (of 2)` on
  stderr.

- [ ] **Batch from stdin**
  ```bash
  printf "SELECT count(*) AS n FROM stores;\nSELECT count(*) AS n FROM categories;\n" | dittosh dql
  ```
  Expect: same as `-f`.

- [ ] **`--continue-on-error` runs past a failure**
  ```bash
  printf "SELECT count(*) AS n FROM stores;\nSELEC broken;\nSELECT count(*) AS n FROM categories;\n" > /tmp/mt-batch-err.sql
  dittosh dql -f /tmp/mt-batch-err.sql --continue-on-error ; echo "exit: $?"
  ```
  Expect: the two good results on stdout, a `Query error [query/invalid]`
  for `SELEC broken` on stderr, summary `2 ok, 1 failed (of 3)`, `exit: 1`.
  Re-run *without* `--continue-on-error`: only the first result, then the
  error — the third statement never runs.

- [ ] **REPL dot-commands are stripped from batches**
  ```bash
  printf ".collections\nSELECT count(*) AS n FROM stores;\n" | dittosh dql
  ```
  Expect: stderr note `skipping REPL command in batch input: .collections`,
  then the normal result — dot-commands are REPL-only, never executed.

- [ ] **`-o` rejected for multi-statement batches**
  ```bash
  dittosh dql -f /tmp/mt-batch.sql -o /tmp/mt-out.json ; echo "exit: $?"
  ```
  Expect: `--out is only supported for a single statement…`, `exit: 2`.

- [ ] **`-p/--param` binding**
  ```bash
  dittosh dql "SELECT store_name FROM stores WHERE location.city = :city" -p city=Bellevue
  ```
  Expect: the `Zava Retail Bellevue` row.

- [ ] **`--args` inline JSON**
  ```bash
  dittosh dql "SELECT store_name FROM stores WHERE location.city = :city" --args '{"city":"Tacoma"}'
  ```
  Expect: the `Zava Retail Tacoma` row.

- [ ] **Multiple statements in argv are refused**
  ```bash
  dittosh dql "SELECT * FROM stores; SELECT * FROM categories" ; echo "exit: $?"
  ```
  Expect: `trailing text after the statement is not executable: "SELECT *
  FROM categories" — use -f for multiple statements`, `exit: 2`.

## 4. Table display on a TTY

- [ ] **Wide rows fit the window**
  ```bash
  dittosh dql "SELECT * FROM orders LIMIT 5"
  ```
  Expect: the table is exactly your terminal width — no wrapping mush.
  Long values (emails, UUIDs) end with `…`. Numbers (`item_count`,
  `subtotal`, `total`) right-align. `5 rows` footer.

- [ ] **Nested/composite values stay readable**
  ```bash
  dittosh dql "SELECT * FROM inventory LIMIT 5"
  ```
  Expect: composite `_id` and `location` render as ellipsized JSON; the
  table still fits the window.

- [ ] **Narrow query gets generous columns**
  ```bash
  dittosh dql "SELECT store_name, location.city, location.state FROM stores"
  ```
  Expect: 8 rows, columns use available width, nothing truncated
  unnecessarily.

- [ ] **Resize resilience** — re-run the first query with a very narrow
  window (~60 cols) and a very wide one. Expect: still fits, headers
  ellipsize (`fullp…`-style) rather than breaking layout.

## 5. Pager

- [ ] **Long results page**
  ```bash
  dittosh dql "SELECT * FROM orders"
  ```
  Expect: opens in `less` (5,000 rows). Arrows/`space` scroll, `/` searches,
  `q` quits back to your shell.

- [ ] **Opt-out flag**
  ```bash
  dittosh dql "SELECT * FROM orders" --no-pager | wc -l
  ```
  Expect: `75002`. No pager, one clean dump. Note: **piped stdout is JSON,
  not the table** (that's what makes `| jq` work) — pretty-printed JSON is
  15 lines per order, so 5,000 orders + 2 bracket lines = 75,002. To *see*
  the dump instead of counting it:
  ```bash
  dittosh dql "SELECT * FROM orders" --no-pager --format table | head -12
  ```

- [ ] **Opt-out env var**
  ```bash
  DITTOSH_NO_PAGER=1 dittosh dql "SELECT * FROM orders" | wc -l
  ```
  Expect: same — `75002`, no pager.

- [ ] **Short results never page**
  ```bash
  dittosh dql "SELECT * FROM categories"
  ```
  Expect: prints inline (9 rows), no pager flash.

## 6. Output formats & export

- [ ] **Vertical mode: wide rows as record blocks**
  ```bash
  dittosh dql "SELECT * FROM orders LIMIT 3" --format vertical
  ```
  Expect: `── row 1 ──` blocks, `field │ value` lines, values **not**
  truncated (full emails/UUIDs visible).

- [ ] **Markdown to stdout**
  ```bash
  dittosh dql "SELECT store_name, location.city, is_online FROM stores" --format markdown
  ```
  Expect: a GFM table (`| --- |` separator) — paste it into any markdown
  doc/GitHub comment and check it renders.

- [ ] **Markdown to file (extension inference)**
  ```bash
  dittosh dql "SELECT * FROM products WHERE base_price > 500" -o /tmp/expensive.md
  ```
  Expect: `Wrote 12 rows … (markdown)`; the file is a valid markdown table.

- [ ] **HTML report**
  ```bash
  dittosh dql "SELECT * FROM orders WHERE store_name = 'Zava Retail Seattle' LIMIT 25" -o /tmp/seattle-orders.html
  open /tmp/seattle-orders.html
  ```
  Expect: styled table (zebra rows, sticky header), row-count footer,
  no external assets. Try your browser's dark mode too.

- [ ] **JSON and CSV to file**
  ```bash
  dittosh dql "SELECT * FROM categories" -o /tmp/cats.json
  dittosh dql "SELECT * FROM categories" -o /tmp/cats.csv
  ```
  Expect: valid JSON array / RFC-4180 CSV with header row.

- [ ] **Files keep full fidelity** (no `…` truncation)
  ```bash
  dittosh dql "SELECT * FROM orders LIMIT 5" -o /tmp/orders.txt
  ```
  Expect: a plain table with complete values — ellipsization is TTY-only.

- [ ] **Explicit format beats extension**
  ```bash
  dittosh dql "SELECT * FROM categories" -o /tmp/cats.txt --format csv
  ```
  Expect: CSV content in a `.txt` file.

- [ ] **`-o` rejected for mutations/DDL**
  ```bash
  dittosh dql "INSERT INTO stores DOCUMENTS ({'_id':'x'})" -o /tmp/nope.json ; echo "exit: $?"
  ```
  Expect: `-o/--out only applies to row-producing statements
  (SELECT/EXPLAIN/PROFILE)`, `exit: 2`, nothing written.

## 7. Safety rails

- [ ] **No-LIMIT heads-up** (once per config dir, TTY stderr only)
  ```bash
  DITTOSH_CONFIG_DIR=/tmp/mt-fresh-config dittosh dql "SELECT * FROM stores"
  ```
  Expect, before the table: `heads up: this SELECT has no LIMIT — unbounded
  queries can return very large result sets. Add LIMIT, use --max-rows, or
  write to a file with -o. (shown once)`. Re-run: no warning (the state is
  remembered; the fresh `DITTOSH_CONFIG_DIR` is what resets it here).

- [ ] **`--max-rows` truncates with a warning**
  ```bash
  dittosh dql "SELECT * FROM categories" --max-rows 3
  ```
  Expect: 3 rows, and on stderr: `showing first 3 of 9 rows — add a LIMIT
  clause`.

## 8. Import external data (`dql import`)

The standard import format is a **JSON array of objects**; NDJSON (one
object per line) is also accepted. `_id` is optional — docs without one get
a generated UUID. Imports upsert (`ON ID CONFLICT DO UPDATE`), so files
*with* `_id`s re-import cleanly; files *without* duplicate on re-import.

- [ ] **Import a JSON array**
  ```bash
  cat > /tmp/import.json <<'EOF'
  [
    { "_id": "imp_1", "name": "Brass Hammer", "price": 24.99, "tags": ["hand", "clearance"] },
    { "_id": "imp_2", "name": "Cordless Drill", "price": 129.0 }
  ]
  EOF
  dittosh dql import /tmp/import.json imported_products
  ```
  Expect: `Imported 2 documents into imported_products (…s)` on stdout,
  progress notes on stderr.

- [ ] **Query it back**
  ```bash
  dittosh dql "SELECT * FROM imported_products ORDER BY _id"
  ```
  Expect: the 2 docs, nested `tags` array intact.

- [ ] **Re-import is idempotent**
  ```bash
  dittosh dql import /tmp/import.json imported_products
  dittosh dql "SELECT count(*) AS n FROM imported_products"
  ```
  Expect: still `[{"n":2}]` — upsert, not duplicates.

- [ ] **`--batch-size` is accepted**
  ```bash
  dittosh dql import /tmp/import.json imported_products --batch-size 1
  ```
  Expect: `Imported 2 documents …` (one doc per INSERT batch).

- [ ] **Docs without `_id` get a generated UUID**
  ```bash
  echo '[{"name": "no id here"}]' > /tmp/noid.json
  dittosh dql import /tmp/noid.json imported_misc
  dittosh dql "SELECT _id, name FROM imported_misc"
  ```
  Expect: the doc carries a UUID `_id`. (Import the same file again and you
  get a second copy — stable identity needs `_id` in the file.)

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
  dittosh dql import /tmp/import.json "bad;name" ; echo "exit: $?"
  ```
  Expect: clear messages ("Cannot read file", "expected a JSON array…",
  "invalid collection name"), all `exit: 2`.

## 9. jq pipelines (`--args -` / `--args @file`)

- [ ] **Query → jq**
  ```bash
  dittosh dql "SELECT _id, product_name, base_price FROM products WHERE base_price > 500" | jq '.[0]'
  ```
  Expect: jq parses cleanly (stdout is pure JSON — no banners/warnings).

- [ ] **Full round trip: query → jq → query**
  ```bash
  dittosh dql "SELECT _id FROM products WHERE base_price > 500 LIMIT 1" \
    | jq '{pid: .[0]._id}' \
    | dittosh dql "SELECT product_name, base_price FROM products WHERE _id = :pid" --args -
  ```
  Expect: one product row, exit 0.

- [ ] **Second round trip, different shape**
  ```bash
  dittosh dql "SELECT _id FROM stores WHERE is_online = true" \
    | jq '{sid: .[0]._id}' \
    | dittosh dql "SELECT * FROM inventory WHERE store_id = :sid LIMIT 5" --args -
  ```
  Expect: up to 5 inventory rows for the online store.

- [ ] **Params from a file**
  ```bash
  echo '{"city": "Bellevue"}' > /tmp/params.json
  dittosh dql "SELECT store_name, location.city FROM stores WHERE location.city = :city" --args @/tmp/params.json
  ```
  Expect: the Bellevue store row.

- [ ] **`-p` overrides `--args`**
  ```bash
  dittosh dql "SELECT store_name FROM stores WHERE location.city = :city" --args @/tmp/params.json -p city=Tacoma
  ```
  Expect: the Tacoma store, not Bellevue.

- [ ] **Bad pipeline input fails clean**
  ```bash
  echo '[1,2]' | dittosh dql "SELECT * FROM stores" --args - ; echo "exit: $?"
  ```
  Expect: `--args must be a JSON object` on stderr, `exit: 2`.

## 10. REPL (interactive shell)

- [ ] **Start it**
  ```bash
  dittosh dql
  ```
  Expect: `dql>` prompt.

- [ ] **In the shell:**
  ```sql
  SELECT * FROM categories;
  SELECT * FROM orders LIMIT 3;
  .collections
  .indexes orders
  .help
  ```
  Expect: fitted tables (same TTY rules as one-shot), a dim `(N ms)` timing
  note after every statement (always on in the shell — no flag needed),
  collection/index listings, help text. Long in-shell results page through
  less.

- [ ] **Multi-line statement**
  ```sql
  SELECT store_name, location.city
  FROM stores
  WHERE is_online = true;
  ```
  Expect: continuation prompt until the `;`, then the result.

- [ ] **Discard a half-typed statement** — start a multi-line statement,
  then `.break` (or `.clear`) at the continuation prompt. Expect: buffer
  discarded, fresh `dql>` prompt, nothing executed.

- [ ] **Exit** with `.exit` — expect a clean return to your shell.

## 11. Diagnostics (`--time` / `--explain` / `--profile` / `--advise`)

- [ ] **Timing footer**
  ```bash
  dittosh dql "SELECT * FROM orders WHERE store_id = 'store_seattle'" --time --no-pager
  ```
  Expect: the table (or JSON when piped), then a dim `Time: N ms` footer on
  **stderr**.

- [ ] **stdout stays clean (jq composability)**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM orders" --time | jq '.[0].n'
  ```
  Expect: `5000` — the timing goes to stderr, the pipe sees pure JSON.

- [ ] **Timing on a mutation**
  ```bash
  dittosh dql "INSERT INTO imported_misc DOCUMENTS ({'_id':'t1','v':1}) ON ID CONFLICT DO UPDATE" --time
  ```
  Expect: `OK`, then `Time: N ms` on stderr.

- [ ] **Server breakdown with --profile**
  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --time --profile
  ```
  Expect: the footer gains the server-side timings —
  `Time: N ms — server: elapsed … · parse … · plan …`.

- [ ] **Per-statement timing in a batch**
  ```bash
  printf "SELECT count(*) FROM orders;\nSELECT count(*) FROM customers;\n" | dittosh dql --time
  ```
  Expect: one `Time: N ms` footer per statement, then the
  `2 ok, 0 failed (of 2)` summary — all on stderr.

- [ ] **REPL contrast** — covered in section 10: the shell shows `(N ms)`
  per statement with no flag; `--time` is a one-shot/batch flag.

- [ ] **Plan**
  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --explain
  ```
  Expect: the EXPLAIN operator tree after the result (`Query plan` →
  `sequence` → `scan` → `filter` → `finalProjection` on a fresh store;
  piped, the plan lands on stderr).

- [ ] **Profile**
  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --profile
  ```
  Expect: per-operator timings with the hotspot flagged (`▲ HOT`), a
  `Results 1` summary line.

- [ ] **Index advice** — quick check (the full story is the demo flow,
  section 13):
  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --advise
  ```
  Expect: a suggested `CREATE INDEX` on `email`, plus a copy-pasteable
  `apply with:` line carrying the full statement.

## 12. Exit codes & locking

- [ ] **Query error → 1**
  ```bash
  dittosh dql "SELEC broken" ; echo "exit: $?"
  ```

- [ ] **Usage error → 2**
  ```bash
  dittosh dql "SELECT * FROM stores" --format yaml ; echo "exit: $?"
  ```

- [ ] **Success → 0**
  ```bash
  dittosh dql "SELECT * FROM stores LIMIT 1" > /dev/null ; echo "exit: $?"
  ```

- [ ] **Lock → 4** (optional, two terminals): start the REPL in one
  terminal (`dittosh dql`), then in another:
  ```bash
  dittosh dql "SELECT * FROM stores LIMIT 1" ; echo "exit: $?"
  ```
  Expect: a "in use by another dittosh process" message, `exit: 4`.
  `.exit` the REPL and re-run — succeeds.

## 13. Demo flow: fresh store → indexes → ADVISE & EXPLAIN

A narrated walkthrough you can run as a demo: nuke the store, reload retail,
prove indexes are absent, then let ADVISE + EXPLAIN tell the index story.
(Uses the default data dir throughout.)

- [ ] **13.1 Delete the database**
  ```bash
  dittosh dql delete-store            # refuses without -y: exit 2
  dittosh dql delete-store -y
  ```
  Expect: `Deleted the store at …` — the directory is gone from disk:
  collections, indexes, lock file, everything. (`dataset reset retail -y`
  is the lighter option — documents evicted, indexes kept.)

- [ ] **13.2 Delete is lock-aware** (optional, two terminals): start the
  REPL in one (`dittosh dql`), run `dittosh dql delete-store -y` in the
  other. Expect: exit 4, "in use by another dittosh process", store
  intact. `.exit` the REPL and re-run — deletion succeeds.

- [ ] **13.3 Load retail fresh**
  ```bash
  dittosh dql dataset load retail
  dittosh dql "SELECT count(*) AS n FROM orders"
  ```
  Expect: `[{"n":5000}]`.

- [ ] **13.4 Prove a fresh load has no indexes**
  ```bash
  dittosh dql "SELECT * FROM system:indexes"
  ```
  Expect: `[]` — `dataset load` never creates indexes (the benchmark
  catalog pairs `_no_index`/`_indexed` variants; indexes are per-query
  setup). This is what gives ADVISE something to say.

- [ ] **13.5 Baseline: the unindexed query**
  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --explain
  ```
  Expect: the plan leads with `scan collection=customers` (full collection
  scan) followed by a separate `filter` operator. With `--profile` instead:
  `scan … · 1251 out` — it reads **every** customer doc to find one, and
  `filter` is flagged ▲ HOT.

- [ ] **13.6 ADVISE recommends the index**
  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --advise
  ```
  Expect: `customers — equality predicates on email` with
  ``CREATE INDEX IF NOT EXISTS adv_customers_email ON default:`customers` (`email` ASC)``,
  plus an `apply with:` line carrying the full statement — copy-pasteable
  verbatim (`dittosh dql --advise --apply "SELECT * FROM customers WHERE …"`).

- [ ] **13.7 Apply it**
  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --advise --apply -y
  ```
  Expect: the same advice with `✓ created`.

- [ ] **13.8 Validate the index works**
  ```bash
  dittosh dql indexes customers
  ```
  Expect: `customers.adv_customers_email` on `email` (asc).

  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --explain
  ```
  Expect: the plan now leads with `indexScan … "index":"adv_customers_email"`
  + `fetch` — no more full `scan`.

  ```bash
  dittosh dql "SELECT * FROM customers WHERE email = 'john21@example.net'" --profile
  ```
  Expect: `indexScan … · 1 out` — exactly one document read, versus 1,251
  before. That's the demo money shot.

- [ ] **13.9 Catalog cross-check** (optional): the benchmark suite ships its
  own indexed variant of this query:
  ```bash
  dittosh dql dataset run customers__select__by_email_indexed --dataset retail --setup
  ```
  Expect: `--setup` runs the catalog's `CREATE INDEX` DDL first, then the
  query returns the anchor customer.

## 14. Cleanup

- [ ] **Delete the store when done**
  ```bash
  dittosh dql delete-store -y
  ```
