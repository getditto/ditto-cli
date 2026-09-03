# Manual testing — `dittosh dql` diagnostics (`--time` / `--explain` / `--profile` / `--advise`)

Checklist for the query-diagnostics flags: timing footers, the EXPLAIN
operator tree, PROFILE hotspots, and the ADVISE index-suggestion flow
(including `--apply`).

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off as a comment under the
failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

Two things that are **not** bugs:

- The ~7 `warning:`/`INFO` lines at startup are the SDK's native tracing
  bootstrap writing to **stderr**. stdout stays clean.
- Piped stdout is always **JSON**; plans/profiles/timings go to **stderr**
  when piped, so pipes never see them.

## 1. Setup

- [ ] **Clean store + the movies dataset** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: `Loaded 10000 documents into 1 collections`. No indexes exist yet
  (`dittosh dql indexes` → `[]`) — that's what makes the ADVISE story
  visible.

## 2. Timing (`--time`)

- [ ] **Timing footer**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies" --time
  ```
  Expect: the result, then a dim `Time: N ms` footer on **stderr**.

- [ ] **stdout stays clean (jq composability)**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies" --time | jq '.[0].n'
  ```
  Expect: `10000` — the timing goes to stderr, the pipe sees pure JSON.

- [ ] **Timing on a mutation**
  ```bash
  dittosh dql "INSERT INTO movies DOCUMENTS ({'_id':{'id':'t1','title':'Test','year':'2026','type':'movie'},'rated':'G'}) ON ID CONFLICT DO UPDATE" --time
  ```
  Expect: `OK`, then `Time: N ms` on stderr.

- [ ] **Per-statement timing in a batch**
  ```bash
  printf "SELECT count(*) FROM movies;\nSELECT count(*) FROM movies WHERE rated = 'PG';\n" | dittosh dql --time
  ```
  Expect: one `Time: N ms` footer per statement, then the
  `2 ok, 0 failed (of 2)` summary — all on stderr.

- [ ] **REPL contrast** — the interactive shell shows `(N ms)` per statement
  with no flag; `--time` is a one-shot/batch flag (see
  `testing-dql-repl.md`).

## 3. Plan (`--explain`)

- [ ] **Plan after the result**
  ```bash
  dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG'" --explain
  ```
  Expect (TTY): the result table, then the EXPLAIN operator tree
  (`Query plan` → … → `scan` → `filter` on a fresh, index-less store).
  Piped: JSON rows on stdout, the plan on **stderr**.

## 4. Profile (`--profile`)

- [ ] **Per-operator timings**
  ```bash
  dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG'" --profile
  ```
  Expect: per-operator timings with the hotspot flagged (`▲`), a results
  summary line.

- [ ] **Server breakdown with `--time`**
  ```bash
  dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG'" --time --profile
  ```
  Expect: the footer gains the server-side timings —
  `Time: N ms — server: elapsed … · parse … · plan …`.

## 5. Advice (`--advise` / `--apply`)

- [ ] **Index suggestion**
  ```bash
  dittosh dql --advise "SELECT * FROM movies WHERE rated = 'PG'"
  ```
  Expect: an `Index advice` report naming the predicate and a ready-to-run
  `CREATE INDEX IF NOT EXISTS adv_movies_rated ON default:\`movies\`
  (\`rated\` ASC)`, plus a copy-pasteable `apply with:` line carrying the
  full statement. (Report — not rows — so it's the same shape TTY or piped.)

- [ ] **`--advise` can't be combined with `-o`**
  ```bash
  dittosh dql --advise "SELECT * FROM movies WHERE rated = 'PG'" -o /tmp/nope.json ; echo "exit: $?"
  ```
  Expect: `--advise renders a report, not rows — it can't be combined with
  -o/--out`, `exit: 2`.

- [ ] **Apply the advice**
  ```bash
  dittosh dql --advise --apply -y "SELECT * FROM movies WHERE rated = 'PG'"
  ```
  Expect: the advice, then the suggested `CREATE INDEX` executed (`OK`).
  Without `-y` it prompts for confirmation first.

- [ ] **The index now exists**
  ```bash
  dittosh dql indexes movies
  ```
  Expect: an `adv_movies_rated` row.

- [ ] **Plan uses the index**
  ```bash
  dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG'" --explain
  ```
  Expect: the operator tree now shows an index scan instead of a full
  `scan` + `filter`.

## 6. Cleanup

- [ ] **Reset the store** (drops the test index and inserted doc)
  ```bash
  dittosh dql delete-store -y
  rm -f /tmp/nope.json
  ```
