# Manual testing — `dittosh dql dataset` (sample data)

Checklist for the built-in benchmark datasets: `list`, `show`, `load`,
`run`, and `reset`.

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off as a comment under the
failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

Not a bug: the ~7 `warning:`/`INFO` lines at startup are the SDK's native
tracing bootstrap on **stderr**; piped stdout is always JSON.

Full end-to-end passes against specific datasets live in
`testing-dql-retail.md` and `testing-dql-retail-joins.md` — this file is
the command-level checklist.

## 1. Discover (`list` / `show`)

- [ ] **List datasets**
  ```bash
  dittosh dql dataset list
  ```
  Expect (piped → JSON): `movies` (1 collection, 49 queries), `retail`
  (7, 72), `retail-joins` (8, 96), `pos` (3, 44).

- [ ] **Inspect the movies suite**
  ```bash
  dittosh dql dataset show movies
  ```
  Expect: the description, scaling dimension `movies` (default 10000), the
  collection shape, the **setup indexes** list, and the query catalog
  grouped by category — SELECT (38), INDEX_SELECT (7), INSERT (1),
  UPDATE (1), EVICT (1), DELETE (1).

- [ ] **Unknown dataset name**
  ```bash
  dittosh dql dataset show nope ; echo "exit: $?"
  ```
  Expect: an "unknown dataset" style error naming the available suites,
  `exit: 2`.

## 2. Load

- [ ] **Start clean, then load** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: per-collection progress on **stderr**, then
  `Loaded 10000 documents into 1 collections` with a summary table on
  stdout. Exit 0.

- [ ] **Sanity count**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies"
  ```
  Expect: `[{"n":10000}]`.

- [ ] **Scale down with `--docs`**
  ```bash
  dittosh dql dataset reset movies -y
  dittosh dql dataset load movies --docs 250
  dittosh dql "SELECT count(*) AS n FROM movies"
  ```
  Expect: `Loaded 250 documents …`, then `[{"n":250}]`.

- [ ] **Load never creates indexes**
  ```bash
  dittosh dql indexes
  ```
  Expect: `[]` — setup indexes only arrive via `dataset run --setup` or
  ADVISE.

## 3. Run catalog queries

- [ ] **A read query by name**
  ```bash
  dittosh dql dataset run count --dataset movies
  ```
  Expect (piped → JSON): one row with the count of loaded docs
  (`250` if you ran the `--docs` step).

- [ ] **`--setup` applies the query's index DDL first**
  ```bash
  dittosh dql dataset run filtered_query_with_index --dataset movies --setup
  dittosh dql indexes
  ```
  Expect: the query result, and `indexes` now lists a `movies_*` index from
  the suite's setup list.

- [ ] **Unknown query name**
  ```bash
  dittosh dql dataset run nope --dataset movies ; echo "exit: $?"
  ```
  Expect: `Unknown query: nope in dataset "movies". See: dittosh dql
  dataset show <name>`, `exit: 2`.

- [ ] **Write queries are gated on `-y`**
  ```bash
  dittosh dql dataset run update_single --dataset movies ; echo "exit: $?"
  ```
  Expect: `"update_single" is a UPDATE query and mutates the store. Re-run
  with --yes to confirm.` plus the statement on stderr, `exit: 2`, store
  unchanged.

- [ ] **…and run with `-y`**
  ```bash
  dittosh dql dataset run update_single --dataset movies -y
  ```
  Expect: the mutation runs, exit 0.

- [ ] **`-o` refused for write queries**
  ```bash
  dittosh dql dataset run delete_single --dataset movies -y -o /tmp/nope.json ; echo "exit: $?"
  ```
  Expect: `-o/--out only applies to row-producing (read) catalog queries`,
  `exit: 2`.

## 4. Reset

- [ ] **Reset is gated on `-y`**
  ```bash
  dittosh dql dataset reset movies ; echo "exit: $?"
  ```
  Expect: `This evicts all documents in: movies. Re-run with --yes to
  confirm.`, `exit: 2`, docs intact.

- [ ] **Reset evicts the dataset's documents**
  ```bash
  dittosh dql dataset reset movies -y
  dittosh dql "SELECT count(*) AS n FROM movies"
  ```
  Expect: `Reset movies: evicted all documents from 1 collections.`, then
  `[{"n":0}]`. The collection (and any indexes) survive — unlike
  `delete-store`, which removes the whole data directory (see
  `testing-dql-delete-store.md`).

## 5. Cleanup

- [ ] **Reset the store**
  ```bash
  dittosh dql delete-store -y
  rm -f /tmp/nope.json
  ```
