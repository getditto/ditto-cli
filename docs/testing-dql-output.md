# Manual testing — `dittosh dql` output: formats, pager, export

Checklist for the result-rendering surface: TTY table fitting, the pager,
`--format` (table/json/csv/markdown/html/vertical), `-o/--out` export,
`--max-rows`, and color controls.

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off (rendering glitches, ANSI
leaks into files, noise on stdout) as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

Two things that are **not** bugs:

- The ~7 `warning:`/`INFO` lines at startup are the SDK's native tracing
  bootstrap writing to **stderr**. stdout — everything you pipe — stays
  clean.
- Piped stdout is always **JSON**, never the table. The table (and the
  pager) only appear when stdout is a terminal — that's what makes
  `| jq` work.

## 1. Setup

- [ ] **Clean store + the movies dataset** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: `Loaded 10000 documents into 1 collections`.

## 2. Table display on a TTY

- [ ] **Wide rows fit the window**
  ```bash
  dittosh dql "SELECT * FROM movies LIMIT 5"
  ```
  Expect: the table is exactly your terminal width — no wrapping mush. Long
  values (plots, cast lists) end with `…`. Numbers (`runtime`) right-align.
  `5 rows` footer.

- [ ] **Nested/composite values stay readable**
  ```bash
  dittosh dql "SELECT _id, imdb, awards FROM movies LIMIT 5"
  ```
  Expect: composite `_id`, `imdb`, `awards` render as ellipsized JSON; the
  table still fits the window.

- [ ] **Narrow query gets generous columns**
  ```bash
  dittosh dql "SELECT _id.title, _id.year, rated FROM movies LIMIT 8"
  ```
  Expect: 8 rows, columns use available width, nothing truncated
  unnecessarily.

- [ ] **Resize resilience** — re-run the first query with a very narrow
  window (~60 cols) and a very wide one. Expect: still fits, headers
  ellipsize rather than breaking layout.

## 3. Pager

- [ ] **Long results page**
  ```bash
  dittosh dql "SELECT _id.title, _id.year, rated FROM movies"
  ```
  Expect: opens in `less` (10,000 rows). Arrows/`space` scroll, `/`
  searches, `q` quits back to your shell.

- [ ] **Opt-out flag**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies" --no-pager | jq '.[0].n'
  ```
  Expect: `10000` — no pager, clean JSON through the pipe.

- [ ] **Opt-out env var**
  ```bash
  DITTOSH_NO_PAGER=1 dittosh dql "SELECT count(*) AS n FROM movies" | jq '.[0].n'
  ```
  Expect: same — `10000`, no pager.

- [ ] **Short results never page**
  ```bash
  dittosh dql "SELECT DISTINCT rated FROM movies"
  ```
  Expect: prints inline, no pager flash.

## 4. Output formats

- [ ] **Vertical mode: wide rows as record blocks**
  ```bash
  dittosh dql "SELECT * FROM movies LIMIT 2" --format vertical
  ```
  Expect: `── row 1 ──` blocks, `field │ value` lines, values **not**
  truncated (full plots visible).

- [ ] **Markdown to stdout**
  ```bash
  dittosh dql "SELECT _id.title, rated, runtime FROM movies LIMIT 4" --format markdown
  ```
  Expect: a GFM table (`| --- |` separator) — paste it into any markdown
  doc/GitHub comment and check it renders.

- [ ] **CSV**
  ```bash
  dittosh dql "SELECT _id.title, rated FROM movies LIMIT 4" --format csv
  ```
  Expect: RFC-4180 CSV with a header row, quoting where needed.

- [ ] **JSON explicit**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies" --format json
  ```
  Expect: `[{"n":10000}]` even on a TTY (no table).

## 5. Export (`-o/--out`)

- [ ] **Extension inference**
  ```bash
  dittosh dql "SELECT _id.title, rated FROM movies LIMIT 10" -o /tmp/mt-movies.md
  dittosh dql "SELECT _id.title, rated FROM movies LIMIT 10" -o /tmp/mt-movies.csv
  dittosh dql "SELECT _id.title, rated FROM movies LIMIT 10" -o /tmp/mt-movies.json
  ```
  Expect: `Wrote 10 rows … (markdown|csv|json)` on stderr; each file is
  valid for its format.

- [ ] **HTML report**
  ```bash
  dittosh dql "SELECT _id.title, _id.year, rated, imdb.rating FROM movies LIMIT 25" -o /tmp/mt-movies.html
  open /tmp/mt-movies.html
  ```
  Expect: styled table (zebra rows, sticky header), row-count footer, no
  external assets. Try your browser's dark mode too.

- [ ] **Files keep full fidelity** (no `…` truncation)
  ```bash
  dittosh dql "SELECT * FROM movies LIMIT 5" -o /tmp/mt-movies.txt
  ```
  Expect: a plain table with complete values — ellipsization is TTY-only.

- [ ] **Explicit format beats extension**
  ```bash
  dittosh dql "SELECT _id.title FROM movies LIMIT 3" -o /tmp/mt-movies.txt --format csv
  ```
  Expect: CSV content in a `.txt` file.

- [ ] **`-o` rejected for mutations/DDL**
  ```bash
  dittosh dql "INSERT INTO movies DOCUMENTS ({'_id':{'id':'x'}})" -o /tmp/nope.json ; echo "exit: $?"
  ```
  Expect: `-o/--out only applies to row-producing statements
  (SELECT/EXPLAIN/PROFILE)`, `exit: 2`, nothing written.

- [ ] **`-o` rejected for multi-statement batches**
  ```bash
  printf "SELECT count(*) FROM movies;\nSELECT count(*) FROM movies;\n" > /tmp/mt-two.sql
  dittosh dql -f /tmp/mt-two.sql -o /tmp/mt-out.json ; echo "exit: $?"
  ```
  Expect: `--out is only supported for a single statement…`, `exit: 2`.

## 6. Row caps & warnings

- [ ] **No-LIMIT heads-up** (once per config dir, TTY stderr only)
  ```bash
  DITTOSH_CONFIG_DIR=/tmp/mt-fresh-config dittosh dql "SELECT * FROM movies"
  ```
  Expect, before the table: `heads up: this SELECT has no LIMIT — unbounded
  queries can return very large result sets. Add LIMIT, use --max-rows, or
  write to a file with -o. (shown once)`. Re-run: no warning (the state is
  remembered; the fresh `DITTOSH_CONFIG_DIR` is what resets it here).

- [ ] **`--max-rows` truncates with a warning**
  ```bash
  dittosh dql "SELECT * FROM movies" --max-rows 3 --no-pager --format table
  ```
  Expect: 3 rows, and on stderr: `showing first 3 of 10000 rows — add a
  LIMIT clause`.

## 7. Colors

- [ ] **`--no-color`**
  ```bash
  dittosh dql "SELECT DISTINCT rated FROM movies" --no-color
  ```
  Expect: the table renders with box-drawing characters but zero ANSI color
  escapes (compare against a colored run on a TTY).

- [ ] **`NO_COLOR` env var**
  ```bash
  NO_COLOR=1 dittosh dql "SELECT DISTINCT rated FROM movies"
  ```
  Expect: same — no ANSI escapes.

## 8. Cleanup

- [ ] **Remove scratch files**
  ```bash
  rm -f /tmp/mt-movies.* /tmp/mt-two.sql /tmp/mt-out.json /tmp/nope.json
  rm -rf /tmp/mt-fresh-config
  ```
