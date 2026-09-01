# Ditto CLI

The command-line tool for [Ditto](https://www.ditto.live) — run DQL statements against a local, offline-only Ditto store, load realistic sample datasets, and get rich diagnostics (timing, EXPLAIN, PROFILE, ADVISE) in your terminal.

```
$ ditto dql "SELECT _id.title, _id.year, rated FROM movies WHERE _id.year > '2000' LIMIT 3"
┌──────────────┬───────┬───────┐
│ title        │ year      │ rated │
├──────────────┼───────┼───────┤
│ Wild Trek    │ 2002      │ R     │
...
└──────────────┴───────────┴───────┘
3 rows
```

## Installation

```bash
npm i -g @dittolive/cli        # npm (primary)
brew install getditto/tap/ditto # Homebrew (macOS/Linux)
```

The binary is `ditto`. Requires Node.js ≥ 20 for npm installs. Supported platforms (matching the Ditto Node SDK): **macOS arm64, Linux x64/arm64, Windows x64**. Intel Macs (darwin-x64) are not supported by SDK 5.1.0.

The CLI ships with a built-in offline license and runs entirely locally — no account, no credentials, no sync. `startSync()` is never called. All your data lives in one local directory (see [Data directory](#data-directory)).

## Quickstart

```bash
# check your install
ditto dql doctor

# load a sample dataset
ditto dql dataset load movies

# query it
ditto dql "SELECT _id.title, _id.year FROM movies WHERE _id.year > '2000' LIMIT 5"

# or run a curated catalog query by name (prints the statement, then results)
ditto dql dataset run single_result --dataset movies

# pipe results anywhere — stdout is always clean JSON when piped
ditto dql "SELECT title FROM movies" | jq '.[].title'
```

## Commands

### `ditto dql` — run DQL

All four input modes:

```bash
ditto dql "SELECT * FROM movies WHERE year = 1994"   # one-shot (statement arg)
ditto dql -e "SELECT * FROM movies LIMIT 5"          # explicit statement form
ditto dql -f script.dql                              # run a file of statements
echo "SELECT * FROM movies LIMIT 3;" | ditto dql     # piped stdin
ditto dql                                            # interactive REPL
```

| Flag | Description |
|---|---|
| `-d, --data-dir <path>` | store data here (overrides env/default) |
| `-f, --file <path>` | run statements from a file (`;`-separated) |
| `-e, --execute <stmt>` | explicit statement (alternative to the positional) |
| `-p, --param name=value` | bind `:name` parameters (repeatable; values JSON-parsed with string fallback) |
| `--args <json>` | bind parameters from a JSON object |
| `-o, --out <path>` | write results to a file (format from extension or `--format`; uncapped unless `--max-rows` is explicit) |
| `--format table\|json\|csv` | output format (default: table on TTY, JSON when piped) |
| `--max-rows <n>` | display cap, default 10,000 |
| `--continue-on-error` | keep running after a failure (batch mode) |
| `--time` | timing footer (host wall-clock + server parse/plan/elapsed when profiling) |
| `--explain` | print the query plan (EXPLAIN side-trip, SELECTs only) |
| `--profile` | print the execution profile with per-operator timings and hotspot flags (SELECTs only) |
| `--advise` | print index advice (ADVISE, SELECTs only) |
| `--apply` | apply ADVISE's suggested `CREATE INDEX` statements (prompts; `-y` skips) |
| `-y, --yes` | skip confirmation prompts |

### `ditto dql doctor`

Platform/arch, Node version, data-directory writability, token validity + expiry, SDK load, and store-lock probe — with an exit code that says what's wrong.

### `ditto dql collections` / `ditto dql indexes [collection]`

List collections (`system:collections`) and indexes (`system:indexes`).

### `ditto dql dataset` — sample data

Four built-in datasets vendored from Ditto's benchmark suites — movies, retail, retail-joins, pos — generated on the fly (nothing pre-generated ships in the package):

```bash
ditto dql dataset list                          # available datasets
ditto dql dataset show retail                   # shapes, setup indexes, full query catalog
ditto dql dataset load retail --docs 5000       # generate + insert (progress on stderr)
ditto dql dataset run stores__select__by_location_city --dataset retail
ditto dql dataset reset retail --yes            # evict the dataset's collections
```

`dataset run` prints the resolved statement (on stderr, so stdout stays clean), then executes it. Query names resolve across datasets; ambiguous names list the matches. `--setup` applies the entry's index DDL first; write-category catalog queries require `--yes` and clean up after themselves. `--seed <n>` reproduces a dataset exactly; changing seeds adds new documents (reset first for a clean slate).

### Global flags

`--no-color`, `--quiet` (suppress informational notes), `--no-update-check` (planned; update flow lands in a later milestone).

### Planned for later milestones

`ditto skills add|update|list` (install the DQL agent skill for Claude Code, OpenCode, Codex, Gemini, Cursor, Copilot, Windsurf — global or project-local), `ditto version`, `ditto update`.

## Data directory

Resolution order: **`--data-dir` flag → `DITTO_DATA_DIR` env var → OS default** (`~/Library/Application Support/ditto` on macOS, `~/.local/share/ditto` on Linux, `%LOCALAPPDATA%\ditto` on Windows). One process at a time per directory (a second one gets a clear lock error, exit 4).

## Output & piping

- **stdout is sacred**: query results are the only thing on stdout (JSON when piped). Warnings, progress, banners, and SDK logs all go to stderr — so `ditto dql "SELECT …" | jq …` always works.
- Diagnostics (`--profile`/`--explain`/`--advise`) render as rich UI on a TTY and route to stderr when piped, so they never corrupt a pipe.
- Colors honor `NO_COLOR`, `CI`, `--no-color`, and non-TTY.
- Attachments appear as `[attachment …]` placeholders (attachment bytes can't flow through DQL).

## Diagnostics

```bash
ditto dql --time "SELECT …"      # timing footer
ditto dql --explain "SELECT …"   # operator plan tree
ditto dql --profile "SELECT …"   # execution profile: summary strip + operator tree + hotspots (▲ = ≥50% of exec time)
ditto dql --advise "SELECT …"    # index suggestions + ready-to-run CREATE INDEX statements
ditto dql --advise --apply -y "SELECT …"  # apply them
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | query/DQL error |
| 2 | usage error (bad flags, missing file, ambiguous dataset query, …) |
| 3 | platform/token/data-dir problem (unsupported OS/arch, expired license, unwritable dir) |
| 4 | data directory locked by another process |

## REPL

Bare `ditto dql` starts an interactive session: multi-line statements terminated with `;`, history, per-statement timing, dot-commands (`.help`, `.collections`, `.indexes [name]`, `.break`, `.exit`).

## Development

```bash
npm run dev -- <args>   # run from source (loads .env — see .env.sample)
npm test                # all tests (unit + integration + e2e)
npm run coverage        # with the 85% coverage gate
npm run lint            # biome
npm run typecheck       # tsc --noEmit
npm run build           # tsup → dist/cli.js
```

## Known issues

- The Ditto SDK 5.1.0 prints ~7 lines of tracing noise to stderr at init (fd-level, not suppressible from JS) — cosmetic only; stdout stays clean.
- The `retail-joins` catalog query `joins__left__products_inventory_stock_value` hangs SDK 5.1.0 when the `inv_store_flat` index exists (upstream; marked as a known issue in `dataset show`/`dataset run`). Workaround: run without `--setup`, or add `LIMIT`.
- `SELECT * FROM system:collections` returns rows only on the first `execute` of a session (upstream; reported).
- CSV output does not escape formula-injection characters (`=`, `+`, `@`) — don't feed it into Excel unsanitized.

## License

Proprietary — © Ditto.
