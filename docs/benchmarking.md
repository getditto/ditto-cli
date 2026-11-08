# Benchmarking DQL with `dittosh dql bench`

`dittosh dql bench` times DQL statements against your local store. It runs each
statement many times, optionally after an untimed warmup, and reports mean, p50,
p95, p99, min, max, and standard deviation. Statements that run before, between,
and after the timed runs create indexes and put data back, so every run starts
from the same state.

It follows the method of Ditto's DQL benchmark suites (`dql-metrics-benchmark`):
the same file format, the same order of steps, the same warmup sizing, and the
same percentile formulas. A suite's `benchmarks.json` runs here unchanged.

## Quick start

```bash
dittosh dql dataset load movies                      # some data to measure
dittosh dql bench "SELECT * FROM movies WHERE rated = 'PG'" --runs 100 --warmup

dittosh dql bench --example movies -o movies-bench.json   # a sample file to copy from
dittosh dql bench -f movies-bench.json --runs 50 --warmup
```

## Options

| Option | Meaning |
|---|---|
| `[statement]` | The statement to time. Use this or `-f`. |
| `-f, --file <path>` | A JSON benchmark file (format below). |
| `--only <a,b>` | With `-f`: run only these benchmarks, in file order. |
| `--runs <n>` | Timed runs per benchmark, 1–10,000. Default 50. |
| `--warmup [n]` | Untimed runs before timing. With no number (or `auto`), enough runs to fill about 250 ms (at least 1, at most 1,000). `--warmup 0`, or leaving the flag out, means no warmup. |
| `--pre <stmt>` | Run once before warmup and timing. Repeatable. |
| `--before-each <stmt>` | Run before every warmup and timed run, untimed. Repeatable. The file version is `resetQueries`. |
| `--reset <stmt>` | Same as `--before-each`. |
| `--post <stmt>` | Run once at the end, even after a failure. Repeatable. |
| `--example <dataset>` | Write a sample benchmark file for `movies`, `retail`, `retail-joins`, or `pos`: to stdout, or to the `-o` path. |
| `-o, --out <path>` | Write the results to a file; the extension picks the format (`.json`, `.csv`, `.md`, `.html`). |
| `--format <fmt>` | `table`, `json`, `csv`, `markdown`, `html`, or `vertical`. Defaults to a table in a terminal and JSON when piped. |
| `-d, --data-dir <path>` | The store to use. |

With `-f`, `--pre` and `--before-each` statements run before each benchmark's own, and
`--post` statements run after its own.

`dittosh dql dataset run <query> --runs <n> [--warmup [n]]` benchmarks one query from
a sample dataset's catalog with the same runner. It keeps `dataset run`'s setup rules:
write queries always run their fixtures and cleanup (and need `--yes`); read queries
create their index only with `--setup`, and keep it afterwards. Without `--runs`
it runs the query once (one timing).

`--pre` runs **once**, not before every run. To time a write against data that must
be there each time, such as evicting a test document, insert it with `--before-each`:

```bash
dittosh dql bench "EVICT FROM movies WHERE _id = 'bench-doc'" --runs 50 \
  --before-each "INSERT INTO movies VALUES ({'_id': 'bench-doc', 'rated': 'TEST'})"
```

With the insert in `--pre` instead, only the first run would evict anything.

## What happens, in order

For each benchmark:

1. **`preQueries`** run once. Typical use: `CREATE INDEX`, or inserting a test document.
2. **Warmup** (if asked for): the query runs untimed, `resetQueries` before each run.
   The first run of a query pays for cold caches and query planning; warmup keeps
   that out of the numbers. With auto warmup, the first warmup run is timed to decide
   how many more fit in 250 ms.
3. **Timed runs**: `resetQueries` run (untimed), then the query runs and its time is
   recorded. This repeats `--runs` times.
4. **`postQueries`** run once, **even if an earlier step failed**. Typical use:
   `DROP INDEX`, removing test documents.

If a step fails, the benchmark stops, the failure and statement are printed on
stderr, the post statements still run, and the result row is marked failed. Other
benchmarks in the file still run. The command exits 1 if any benchmark (or any
post statement) failed, and 2 for usage errors such as a bad file.

A write benchmark that runs more than once with no `resetQueries` gets a warning:
after the first run, an `EVICT` or `DELETE` usually finds nothing to remove, and
an `INSERT` of a fixed `_id` fails or does nothing.

## The benchmark file format

A benchmark file is a JSON object. Each key names a benchmark, and each value
describes it:

```json
{
  "movies_by_rating": {
    "description": "Optional: a note for people reading the file.",
    "preQueries": [
      "DROP INDEX IF EXISTS movies_rated ON movies",
      "CREATE INDEX movies_rated ON movies (rated)"
    ],
    "query": "SELECT * FROM movies WHERE rated = 'PG'",
    "postQueries": ["DROP INDEX IF EXISTS movies_rated ON movies"]
  },
  "evict_one": {
    "resetQueries": ["INSERT INTO movies VALUES ({'_id': 'bench-doc', 'rated': 'TEST'})"],
    "query": "EVICT FROM movies WHERE _id = 'bench-doc'"
  }
}
```

| Key | Required | Meaning |
|---|---|---|
| `query` | yes | The statement that is timed. |
| `preQueries` | no | Statements run once, before warmup and timing. |
| `resetQueries` | no | Statements run before every warmup and timed run, untimed (`--before-each` on the command line). |
| `postQueries` | no | Statements run once at the end, even after a failure. |
| `description` | no | Free text; not used by the runner. |

- Each list holds strings, one DQL statement each. A single string also works.
- A trailing `;` on a statement is optional.
- Key order doesn't matter. The sample files list them in the order they run.
- Keys the DQL benchmark suites use for their own tools (`category`, `qb`,
  `sql_equivalent`, `expected_count`, `expected_first_rows_hash`, `negative`,
  `expected_error_substring`) are accepted and ignored. Any other key is an error,
  with a suggestion when it looks like a typo (`prequeries` → `preQueries`). This
  stops a misspelled key from silently skipping an index.

Two other shapes are accepted:

- **A list** of benchmarks, each with an optional `"name"` (unnamed ones become
  `benchmark_1`, `benchmark_2`, …):
  `[{"name": "pg", "query": "SELECT * FROM movies WHERE rated = 'PG'"}]`
- **A single benchmark**, with `query` at the top level:
  `{"query": "SELECT count(*) FROM movies"}`

## Creating a benchmark file

1. **Start from a sample.** `dittosh dql bench --example <dataset> -o my-bench.json`
   writes a few entries from that dataset's query catalog: a plain read, an indexed
   read, an aggregate (and a join, for `retail-joins`), and a write that restores its
   own data. Each has a `description` that explains its parts. Load the dataset
   (`dittosh dql dataset load <dataset>`) to run it as is.
2. **Write the statement you want to time** as `query`. Run it once with
   `dittosh dql "<query>"` first to check it returns what you expect.
3. **Decide what state it needs.**
   - A read that should use an index: create the index in `preQueries` and drop it in
     `postQueries`. Start `preQueries` with `DROP INDEX IF EXISTS …` so a leftover
     index from an interrupted run doesn't fail the `CREATE INDEX`.
   - A write: make every run do the same work. Use `resetQueries` to put the data
     back before each run. For example, re-insert the document an `EVICT` removes,
     or evict the document an `INSERT` adds. Use `postQueries` to remove test
     documents at the end.
   - Use `_id`s that can't collide with real data, such as `bench-…`.
4. **Check that the store ends as it started.** Compare
   `dittosh dql "SELECT count(*) FROM <collection>"` and `dittosh dql indexes` before
   and after a run.
5. **Run it:** `dittosh dql bench -f my-bench.json --runs 50 --warmup`.

## Reading the results

```
benchmark         runs  warmup  rows  mean_ms  p50_ms  p95_ms  p99_ms  min_ms  max_ms  stddev_ms
movies_by_rating    50      84   312    2.941   2.902   3.214   3.390   2.811   3.390      0.112
```

- `rows`: rows returned by the last timed run (0 for writes).
- `p50_ms` is the median. `p95_ms` and `p99_ms` take the sorted sample at
  index ⌊n × 0.95⌋ and ⌊n × 0.99⌋, as the benchmark suites do. With fewer than 100
  runs, p99 is the slowest run; use more runs for a meaningful tail.
- `stddev_ms` is the population standard deviation.
- With `--runs 1`, the table shows just `rows` and `time_ms`.
- Times are wall-clock time for `execute` from the CLI, including moving results
  from the SDK into JavaScript. Compare runs made on the same machine with the same
  data. Load a larger dataset (`dataset load <name> --docs <n>`) to see how a query
  scales.

To compare a change, save results with `-o before.json`, make the change (such as
an index), and run again with `-o after.json`.
