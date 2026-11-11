# dittosh — the Ditto CLI

The command-line tool for [Ditto](https://www.ditto.live) — run DQL statements against a local, offline-only Ditto store, load realistic sample datasets, and get rich diagnostics (timing, EXPLAIN, PROFILE, ADVISE) in your terminal. The binary is `dittosh` (named to avoid clashing with the `ditto` tool shipped with macOS/Linux).

```
$ dittosh dql "SELECT _id.title, _id.year, rated FROM movies WHERE _id.year > '2000' LIMIT 3"
┌─────────┬───────────────┬──────┐
│ rated   │ title         │ year │
├─────────┼───────────────┼──────┤
│ UNRATED │ Wild Trek     │ 2002 │
│ R       │ Hidden Mirror │ 2008 │
│ R       │ Silent Runner │ 2013 │
└─────────┴───────────────┴──────┘
3 rows
```

## Installation

```bash
npm i -g @dittolive/cli          # npm (primary)
brew trust getditto/tap           # Homebrew (macOS/Linux): trust the tap once,
brew install getditto/tap/dittosh # then install
```

Newer Homebrew versions refuse to load formulas from a third-party tap until you trust it. If `brew` reports `Refusing to load formula getditto/tap/dittosh from untrusted tap`, run `brew trust getditto/tap` and try again.

The binary is `dittosh`. Requires Node.js ≥ 22 for npm installs; Homebrew manages Node.js 24. Supported platforms (matching the Ditto Node SDK): **macOS arm64, Linux x64/arm64, Windows x64**. Intel Macs (darwin-x64) are not supported by SDK 5.2.0. Homebrew installs only your platform's copy of the Ditto SDK (about 150 MB on macOS, 180 MB on Linux); npm installs include every platform's (about 420 MB).

Update using the package manager you installed with:

```bash
npm install -g @dittolive/cli@latest
# or
brew update && brew upgrade dittosh
```

If `brew upgrade` says the tap is untrusted, run `brew trust getditto/tap` once and upgrade again.

`dittosh update` detects npm or Homebrew and runs the matching update command.
Maintainers: see [Publishing releases](docs/publishing.md) for the tag workflow,
required release notes, npm authentication, and Homebrew tap setup.

The CLI ships with a built-in offline license and runs entirely locally — no account, no credentials, no sync. `startSync()` is never called. All your data lives in one local directory (see [Data directory](#data-directory)).

## Quickstart

```bash
# check your install
dittosh doctor

# load a sample dataset
dittosh dql dataset load movies

# query it
dittosh dql "SELECT _id.title, _id.year FROM movies WHERE _id.year > '2000' LIMIT 5"

# or run a curated catalog query by name (prints the statement, then results)
dittosh dql dataset run single_result --dataset movies

# pipe results anywhere — stdout is always clean JSON when piped
dittosh dql "SELECT title FROM movies" | jq '.[].title'
```

## Commands

### `dittosh dql` — run DQL

All four input modes:

```bash
dittosh dql "SELECT * FROM movies WHERE year = 1994"   # one-shot (statement arg)
dittosh dql -e "SELECT * FROM movies LIMIT 5"          # explicit statement form
dittosh dql -f script.dql                              # run a file of statements
echo "SELECT * FROM movies LIMIT 3;" | dittosh dql     # piped stdin
dittosh dql                                            # interactive REPL
```

| Flag | Description |
|---|---|
| `-d, --data-dir <path>` | store data here (overrides env/default) |
| `-f, --file <path>` | run statements from a file (`;`-separated) |
| `-e, --execute <stmt>` | explicit statement (alternative to the positional) |
| `-p, --param name=value` | bind `:name` parameters (repeatable; values JSON-parsed with string fallback) |
| `--args <json>` | bind parameters from a JSON object — `-` reads stdin, `@file` reads a file |
| `-o, --out <path>` | write results to a file (format from extension — `.json`/`.csv`/`.md`/`.html` — or `--format`; uncapped unless `--max-rows` is explicit) |
| `--format table\|json\|csv\|markdown\|html\|vertical` | output format (default: table on TTY, JSON when piped). `vertical` = one block per row, values never truncated |
| `--max-rows <n>` | display cap, default 10,000 |
| `--no-pager` | never pipe long TTY output through `$PAGER`/`less` (also: `DITTOSH_NO_PAGER=1`) |
| `--continue-on-error` | keep running after a failure (batch mode) |
| `--time` | timing footer (host wall-clock + server parse/plan/elapsed when profiling) |
| `--explain` | print the query plan (EXPLAIN side-trip, SELECTs only) |
| `--profile` | print the execution profile with per-operator timings (exec/recv/send/stor), document counts, scheduler yields, join subplans, and hotspot flags (SELECTs only) |
| `--advise` | print index advice (ADVISE, SELECTs only) |
| `--apply` | apply ADVISE's suggested `CREATE INDEX` statements (prompts; `-y` skips) |
| `-y, --yes` | skip confirmation prompts |

On a terminal, tables fit the window width (long values ellipsize with `…`) and long results page through `less`. Piped stdout is always clean JSON, so results compose with `jq` — and `--args -` feeds a transformed result back in as parameters:

```bash
# find an id with one query, fetch the full doc with another
dittosh dql "SELECT _id FROM movies WHERE _id.year = '2001' LIMIT 1" \
  | jq '{id: .[0]._id}' \
  | dittosh dql "SELECT * FROM movies WHERE _id = :id" --args -
```

### `dittosh doctor` (also `dittosh dql doctor`)

Platform/arch, Node version, data-directory writability, token validity + expiry, SDK load, and store-lock probe — with an exit code that says what's wrong.

**Reporting a bug?** `dittosh doctor --report` writes `dittosh-report-<time>.tar.gz` to attach to a [GitHub issue](https://github.com/getditto/ditto-cli/issues/new?template=bug_report.yml): versions, OS and terminal details, the checks, paths and free space, dittosh settings (credentials only as set/not set), a store summary (collection names, counts, indexes; no document contents), the last failed command and its error output, and the Ditto SDK support bundle with the SDK's debug logs. `--no-store` and `--no-sdk-bundle` leave parts out.

- `dittosh dql support-bundle [-o file.tar]` saves only the Ditto SDK support bundle (`--list` shows the ones kept in the store).
- `--debug` (or `DITTOSH_DEBUG=1`) on any command shows the SDK's debug logs and stack traces on stderr; stdout is unchanged.

See [Troubleshooting](docs/troubleshooting.md).

### `dittosh dql collections` / `dittosh dql indexes [collection]`

List collections (`system:collections`) and indexes (`system:indexes`).

### `dittosh dql delete-store`

Permanently delete the local store — the whole data directory: all collections, indexes, and files. Requires `-y` (no prompt); refuses while another process holds the store open (exit 4), and refuses absurd targets like `$HOME` or the cwd. To clear just one dataset's documents instead, use `dittosh dql dataset reset <name> -y`.

### `dittosh dql import <file> <collection>`

Import your own data. The standard format is a **JSON array of objects**:

```json
[
  { "_id": "prod_1", "name": "Brass Hammer", "price": 24.99 },
  { "_id": "prod_2", "name": "Cordless Drill", "price": 129.0 }
]
```

```bash
dittosh dql import products.json products
dittosh dql "SELECT * FROM products WHERE price > 100"
```

- **NDJSON** (one object per line) is accepted too — detected automatically from the first character (`[` → array, `{` → NDJSON).
- **`_id` is optional.** Documents without one get a generated UUID. Imports upsert (`ON ID CONFLICT DO UPDATE`), so re-importing a file with `_id`s is idempotent; re-importing docs *without* `_id` duplicates them.
- **Collection names** must be identifier-style: letters, digits, underscores, not starting with a digit.
- Large files insert in batches (`--batch-size`, default 500); progress on stderr, summary on stdout.
- Exit codes: `2` unreadable/invalid file or bad collection name, `1` insert failed, `0` ok.

### `dittosh dql dataset` — sample data

Four built-in datasets vendored from Ditto's benchmark suites — movies, retail, retail-joins, pos — generated on the fly (nothing pre-generated ships in the package):

```bash
dittosh dql dataset list                          # available datasets
dittosh dql dataset show retail                   # shapes, setup indexes, full query catalog
dittosh dql dataset load retail --docs 5000       # generate + insert (progress on stderr)
dittosh dql dataset run stores__select__by_location_city --dataset retail
dittosh dql dataset reset retail --yes            # evict the dataset's collections
```

`dataset run` prints the resolved statement (on stderr, so stdout stays clean), then executes it. Query names resolve across datasets; ambiguous names list the matches. `--setup` applies the entry's index DDL first; write-category catalog queries require `--yes` and clean up after themselves. `--seed <n>` reproduces a dataset exactly; changing seeds adds new documents (reset first for a clean slate).

### `dittosh dql bench` — benchmark statements

Time a statement over many runs and get mean, p50, p95, p99, min, max, and standard deviation:

```bash
dittosh dql bench "SELECT * FROM movies WHERE rated = 'PG'" --runs 100 --warmup
dittosh dql bench "SELECT * FROM movies WHERE rated = 'PG'" \
  --pre "CREATE INDEX IF NOT EXISTS movies_rated ON movies (rated)" \
  --post "DROP INDEX IF EXISTS movies_rated ON movies"
dittosh dql bench --example movies -o movies-bench.json   # sample benchmark file
dittosh dql bench -f movies-bench.json --runs 50 --warmup
dittosh dql dataset run filtered_query_with_index --runs 50 --warmup   # a catalog query
```

- `--runs <n>`: timed runs (default 50). `--warmup`: untimed runs first, enough to fill about 250 ms; `--warmup <n>` for an exact count.
- `--pre` runs once before timing, `--before-each` (or `--reset`) before every run (untimed, e.g. re-insert the document an `EVICT` removes), `--after-each` after every run (untimed, e.g. evict the document an `INSERT` added), and `--post` once at the end, even after a failure. Each is repeatable.
- `-f <file>`: benchmarks from a JSON file, in the same format as Ditto's DQL benchmark suites: `{"name": {"query": "…", "preQueries": […], "resetQueries": […], "postQueries": […]}}`, plus a dittosh-only `afterEachQueries` list. `--only a,b` picks entries. `--example <dataset>` writes a sample file for `movies`, `retail`, `retail-joins`, or `pos`.
- Results go to stdout (a table in a terminal, JSON when piped, or `-o`/`--format`); progress goes to stderr. Exit code 1 if any benchmark fails.

The full file format, the order of steps, and how to build a benchmark file are in [docs/benchmarking.md](docs/benchmarking.md).

### Global flags

`--no-color`, `--quiet` (suppress informational notes), `--no-update-check` (planned; update flow lands in a later milestone).

### `dittosh skills` — install Ditto agent skills for AI coding agents

```bash
dittosh skills add                    # install the default skill (write-dql) into all detected agents
dittosh skills add swift-sdk          # install a named skill (and the skills it links to)
dittosh skills add js-sdk             # JavaScript/TypeScript: installs every js-* skill and native-app-config
dittosh skills add js-node --no-deps  # just the named skill, without its companions
dittosh skills add --all              # install every skill the upstream repo ships
dittosh skills add --project .        # project-local install
dittosh skills add --agent claude,opencode   # specific agents
dittosh skills add --ref v0.1.0       # pin a specific release
dittosh skills list                   # what's installed where (with upstream ref)
dittosh skills update                 # refresh write-dql installs to the latest release
dittosh skills update --all           # refresh every installed skill (shows current → latest)
dittosh skills versions               # list published releases (newest = latest)
```

Skills come from the upstream [`getditto/agent-skills`](https://github.com/getditto/agent-skills) repo (`write-dql`, `swift-sdk`, `kotlin-sdk`, `js-sdk`, `js-node`, `js-web`, `js-react-native`, `js-expo`, `native-app-config`, `data-modeling`, `data-streams`, `ditto-mesh-networking`, `sync-subscriptions`, …). Tagged releases serve a slim skills-only archive; until a release exists, installs track the `main` branch snapshot. The set of skills is read from the archive at runtime, so new upstream skills work with no CLI update.

Companion skills: some skills link to files in other skills with relative paths (`../js-sdk/assets/runtime.ts`). Those links only resolve when both skills are installed side by side, so `add` reads the links and installs the linked skills too, following links transitively. In agent-skills v0.6.0 and later, any `js-*` skill pulls in the whole JavaScript family (`js-sdk`, `js-node`, `js-web`, `js-react-native`, `js-expo`) plus `native-app-config`; `swift-sdk` pulls in `native-app-config`; `data-streams` pulls in `kotlin-sdk`, `swift-sdk`, and (through `swift-sdk`) `native-app-config`; `data-modeling` pulls in `write-dql`. Companions that are already installed show as `present`. `--no-deps` turns this off and is remembered: `update` then leaves that install's companions alone. Otherwise `update` installs companions that a newer release adds (`update --no-deps` skips that for one run). Copilot and Windsurf get one flattened instruction file per skill, so links to other files can't resolve there; companions are not installed for them.

Semantics: `add` never upgrades an existing install (it skips; `--force` overwrites) — `update` is the version-moving command and skips the download entirely when everything is current. `update` refreshes all installs of a skill across agents (no `--agent` filter); use `--project` to scope to project-local installs. The old `dql` skill name still works as an alias for `write-dql`, and `update` migrates `dql`-era installs to the new name.

Agent targets: Claude Code (`~/.claude/skills` or `.claude/skills`), OpenCode (`~/.agents/skills` or `.agents/skills`), Codex (`~/.codex/skills`), Gemini (`~/.gemini/skills`), Antigravity (`~/.gemini/config/skills` or `.agents/skills`), Cursor (`.cursor/rules`, project-only), Copilot + Windsurf (project instruction files). While `getditto/agent-skills` is private, set `GITHUB_TOKEN` (e.g. `GITHUB_TOKEN=$(gh auth token)`).

### `dittosh tutorial` — learn the CLI and DQL

```bash
dittosh tutorial                       # write ./dittosh-tutorial.md, a hands-on walkthrough of the CLI
dittosh tutorial -o ~/t.md --force     # choose the file / overwrite
dittosh tutorial --stdout              # print the Markdown instead
dittosh tutorial --interactive         # guided DQL lessons, full screen
dittosh tutorial --interactive --plain # the same lessons in a line-by-line shell
dittosh tutorial --interactive --level advanced   # start at beginner | intermediate | advanced
```

The Markdown tutorial is tailored to this install (CLI and SDK version, Homebrew or npm upgrade commands, platform) and covers importing, querying, exporting, the interactive shell and `.metrics`, sample datasets, `--explain`/`--profile`/`--advise`, benchmarking with `dql bench` (including benchmark files), joins, diagnostics with system collections and more advanced DQL, and agent skills. Every runnable command in it is exercised by the e2e suite.

The interactive lessons teach DQL concepts — documents and collections, projection, predicates, boolean logic, sorting, writes, expressions and functions, `CASE`, MISSING vs NULL, aggregation and grouping, joins, `ANY … SATISFIES`, indexes, `EXPLAIN`, `PROFILE`, and system collections — in 27 lessons across beginner, intermediate, and advanced levels. Each lesson explains the idea (with an "if you know SQL" note), shows the syntax, sets a task, and checks your answer. They run in a separate practice store (`<config dir>/tutorial-store`) and save your progress. The lessons open full screen: the lesson stays in a panel at the top, results scroll below it, the latest ✓/✗ verdict sits above the prompt, a sidebar on the left outlines the lessons and your progress (Ctrl+B toggles it), Ctrl+T (or `.schema`) shows the fields of the collections each lesson uses, and `?` slides a help panel in from the right. Press Enter to run a statement (`;` is optional); Tab hints, Ctrl+N/Ctrl+P move between lessons, Ctrl+L picks a lesson from a list, PgUp/PgDn scroll, and Ctrl+D quits. The dot-commands (`.hint`, `.answer`, `.next`/`.back`, `.lessons`, `.level <name>`, `.goto <n>`, `.reset`, `.exit`) work too. `--plain`, or a window smaller than 60×20, uses a simple line-by-line shell instead.

### Planned for later milestones

`dittosh version`, `dittosh update` (self-update banner + channel-aware upgrade).

## Data directory

Resolution order: **`--data-dir` flag → `DITTOSH_DATA_DIR` env var → OS default** (`~/Library/Application Support/dittosh` on macOS, `~/.local/share/dittosh` on Linux, `%LOCALAPPDATA%\dittosh` on Windows). One process at a time per directory (a second one gets a clear lock error, exit 4).

## Output & piping

- **stdout is sacred**: query results are the only thing on stdout (JSON when piped). Warnings, progress, banners, and SDK logs all go to stderr — so `dittosh dql "SELECT …" | jq …` always works.
- Diagnostics (`--profile`/`--explain`/`--advise`) render as rich UI on a TTY and route to stderr when piped, so they never corrupt a pipe.
- Colors honor `NO_COLOR`, `CI`, `--no-color`, and non-TTY.
- Attachments appear as `[attachment …]` placeholders (attachment bytes can't flow through DQL).

## Diagnostics

```bash
dittosh dql --time "SELECT …"      # timing footer
dittosh dql --explain "SELECT …"   # operator plan tree
dittosh dql --profile "SELECT …"   # execution profile: summary strip + operator tree + hotspots (▲ = ≥50% of exec time)
dittosh dql --advise "SELECT …"    # index suggestions + ready-to-run CREATE INDEX statements
dittosh dql --advise --apply -y "SELECT …"  # apply them
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

Bare `dittosh dql` starts an interactive session: multi-line statements terminated with `;`, history, per-statement timing, dot-commands (`.help`, `.collections`, `.indexes [name]`, `.metrics [section]`, `.break`, `.exit`).

`.metrics` shows the SDK's live system metrics for the session as formatted tables — store (SQLite transactions, fsync, WAL size, commit/lock timings) and query/DQL (requests, selects, failures, parse/plan/execution time) by default. Totals run since the session opened; the Change, p50/p90/p99 and Max columns cover the time since the previous `.metrics`. `.metrics query` or `.metrics store` narrows the view; `.metrics all` adds network, sync, transport, and the other sections.

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
- `SELECT * FROM system:collections` returns rows only on the first `execute` of a session (upstream; reported).
- CSV output does not escape formula-injection characters (`=`, `+`, `@`) — don't feed it into Excel unsanitized.

## License

MIT — © Ditto. See [LICENSE.md](LICENSE.md).
