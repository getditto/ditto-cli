# Manual testing — `dittosh dql` statement execution

Checklist for running DQL one-shot and in batches: input modes (positional,
`-e`, `-f`, stdin), parameter binding, batch semantics, and the usage/exit
code contract.

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off (wrong exit codes, noise on
stdout) as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

Two things that are **not** bugs:

- The ~7 `warning:`/`INFO` lines at startup are the SDK's native tracing
  bootstrap writing to **stderr**. stdout — everything you pipe — stays
  clean.
- Piped stdout is always **JSON**, never the table.

Sibling files: `testing-dql-output.md` (formats/pager/export),
`testing-dql-repl.md` (interactive shell), `testing-dql-diagnostics.md`
(`--time`/`--explain`/`--profile`/`--advise`).

## 1. Setup

- [ ] **Clean store + the movies dataset** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: `Deleted the store at …` (or `No store at … — nothing to
  delete.`), then `Loaded 10000 documents into 1 collections` with a summary
  table. Progress on **stderr**.

## 2. Statement input modes

- [ ] **Positional statement**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies"
  ```
  Expect (piped → JSON): `[{"n":10000}]`.

- [ ] **Trailing `;` is tolerated**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies;"
  ```
  Expect: same result — the CLI strips the trailing semicolon (the SDK
  rejects it).

- [ ] **`-e/--execute` form**
  ```bash
  dittosh dql -e "SELECT count(*) AS n FROM movies"
  ```
  Expect: `[{"n":10000}]`.

- [ ] **Batch from a file**
  ```bash
  printf "SELECT count(*) AS n FROM movies;\nSELECT count(*) AS pg FROM movies WHERE rated = 'PG';\n" > /tmp/mt-batch.sql
  dittosh dql -f /tmp/mt-batch.sql
  ```
  Expect: two JSON arrays on stdout, summary `2 ok, 0 failed (of 2)` on
  **stderr**.

- [ ] **Batch from stdin**
  ```bash
  printf "SELECT count(*) AS n FROM movies;\n" | dittosh dql
  ```
  Expect: same as `-f` (one result, `1 ok, 0 failed (of 1)`).

- [ ] **`--continue-on-error` runs past a failure**
  ```bash
  printf "SELECT count(*) AS n FROM movies;\nSELEC broken;\nSELECT count(*) AS pg FROM movies WHERE rated = 'PG';\n" > /tmp/mt-batch-err.sql
  dittosh dql -f /tmp/mt-batch-err.sql --continue-on-error ; echo "exit: $?"
  ```
  Expect: the two good results on stdout, a `Query error` for `SELEC broken`
  on stderr, summary `2 ok, 1 failed (of 3)`, `exit: 1`. Re-run *without*
  `--continue-on-error`: only the first result, then the error — the third
  statement never runs.

- [ ] **REPL dot-commands are stripped from batches**
  ```bash
  printf ".collections\nSELECT count(*) AS n FROM movies;\n" | dittosh dql
  ```
  Expect: stderr note `skipping REPL command in batch input: .collections`,
  then the normal result — dot-commands are REPL-only, never executed.

- [ ] **Empty piped stdin is a usage error**
  ```bash
  dittosh dql < /dev/null ; echo "exit: $?"
  ```
  Expect: `No statements in stdin.`, `exit: 2`.

- [ ] **TTY stdin + redirected stdout never opens the REPL** (run in a
  real terminal):
  ```bash
  dittosh dql > /dev/null ; echo "exit: $?"
  ```
  Expect: `No statement given. Usage: dittosh dql "SELECT ..." (see
  --help)`, exit 2.

## 3. Parameter binding

- [ ] **`-p/--param` binding**
  ```bash
  dittosh dql "SELECT _id.title, rated FROM movies WHERE rated = :rated LIMIT 2" -p rated=PG
  ```
  Expect: 2 rows, both `"rated": "PG"`.

- [ ] **Values are JSON-parsed** (numbers/bools stay typed)
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies WHERE runtime > :min" -p min=200
  ```
  Expect: a count (a numeric `200`, not the string `"200"`).

- [ ] **`--args` inline JSON**
  ```bash
  dittosh dql "SELECT _id.title FROM movies WHERE rated = :rated LIMIT 2" --args '{"rated":"G"}'
  ```
  Expect: 2 rows, both `"G"`.

- [ ] **`--args -` reads the params object from stdin**
  ```bash
  echo '{"rated":"R"}' | dittosh dql "SELECT _id.title FROM movies WHERE rated = :rated LIMIT 2" --args -
  ```
  Expect: 2 rows, both `"R"`.

- [ ] **`--args @file` reads params from a file**
  ```bash
  echo '{"rated":"PG-13"}' > /tmp/mt-params.json
  dittosh dql "SELECT _id.title FROM movies WHERE rated = :rated LIMIT 2" --args @/tmp/mt-params.json
  ```
  Expect: 2 rows, both `"PG-13"`.

- [ ] **`-p` overrides `--args`**
  ```bash
  dittosh dql "SELECT _id.title FROM movies WHERE rated = :rated LIMIT 2" --args @/tmp/mt-params.json -p rated=G
  ```
  Expect: `"G"` rows, not `"PG-13"`.

- [ ] **Bad `--args` input fails clean**
  ```bash
  echo '[1,2]' | dittosh dql "SELECT count(*) FROM movies" --args - ; echo "exit: $?"
  ```
  Expect: `--args must be a JSON object` on stderr, `exit: 2`.

## 4. Usage errors (all exit 2, nothing runs)

- [ ] **Both positional and `-e`**
  ```bash
  dittosh dql "SELECT 1" -e "SELECT 2" ; echo "exit: $?"
  ```
  Expect: `pass the statement either positionally or via -e/--execute, not
  both`, `exit: 2`.

- [ ] **`-f` plus a statement**
  ```bash
  dittosh dql "SELECT 1" -f /tmp/mt-batch.sql ; echo "exit: $?"
  ```
  Expect: `-f/--file cannot be combined with a statement argument`, `exit:
  2`.

- [ ] **Multiple statements in argv are refused**
  ```bash
  dittosh dql "SELECT count(*) FROM movies; SELECT count(*) FROM movies" ; echo "exit: $?"
  ```
  Expect: `trailing text after the statement is not executable: … — use -f
  for multiple statements`, `exit: 2`.

- [ ] **Whitespace/comment-only input**
  ```bash
  dittosh dql "  -- nothing here" ; echo "exit: $?"
  ```
  Expect: `No statement given (input was only whitespace/comments). …`,
  `exit: 2`.

- [ ] **Bad `--format` value**
  ```bash
  dittosh dql "SELECT count(*) FROM movies" --format yaml ; echo "exit: $?"
  ```
  Expect: a `--format must be one of …` message, `exit: 2`.

## 5. Exit codes & locking

- [ ] **Query error → 1**
  ```bash
  dittosh dql "SELEC broken" ; echo "exit: $?"
  ```

- [ ] **Success → 0**
  ```bash
  dittosh dql "SELECT count(*) FROM movies" > /dev/null ; echo "exit: $?"
  ```

- [ ] **Lock → 4** (optional, two terminals): start the REPL in one terminal
  (`dittosh dql`), then in another:
  ```bash
  dittosh dql "SELECT count(*) FROM movies" ; echo "exit: $?"
  ```
  Expect: a "in use by another dittosh process" message, `exit: 4`. `.exit`
  the REPL and re-run — succeeds.

## 6. Cleanup

- [ ] **Remove scratch files**
  ```bash
  rm -f /tmp/mt-batch.sql /tmp/mt-batch-err.sql /tmp/mt-params.json
  ```
