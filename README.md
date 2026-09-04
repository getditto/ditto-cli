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
brew install getditto/tap/dittosh # Homebrew (macOS/Linux)
```

The binary is `dittosh`. Requires Node.js ≥ 20 for npm installs. Supported platforms (matching the Ditto Node SDK): **macOS arm64, Linux x64/arm64, Windows x64**. Intel Macs (darwin-x64) are not supported by SDK 5.1.0.

The CLI ships with a built-in offline license and runs entirely locally — no account, no credentials, no sync. `startSync()` is never called. All your data lives in one local directory (see [Data directory](#data-directory)). (The [`dittosh server`](#dittosh-server--ditto-server-over-http) group is the one exception in kind: a plain HTTPS client for your Ditto Cloud app's HTTP API with *your* portal API key — it never starts sync and never touches the local store.)

## Quickstart

```bash
# check your install
dittosh dql doctor

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
| `--profile` | print the execution profile with per-operator timings and hotspot flags (SELECTs only) |
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

### `dittosh dql doctor`

Platform/arch, Node version, data-directory writability, token validity + expiry, SDK load, and store-lock probe — with an exit code that says what's wrong.

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

### `dittosh server` — Ditto Server over HTTP

Run DQL against your Ditto Cloud app (the Big Peer behind it) over the portal HTTP API — the same API the portal's DQL editor uses. No local store involved; nothing syncs.

```bash
# configure once (or use flags every call)
export DITTOSH_SERVER_URL=https://xxxx.cloud.dittolive.app/your-app-id
export DITTOSH_SERVER_API_KEY=your-api-key

# validate the setup before scripting
dittosh server doctor

# run DQL on the server
dittosh server execute "SELECT * FROM customers LIMIT 5"
dittosh server execute "SELECT * FROM orders WHERE total > :t" -p t=100
dittosh server execute "INSERT INTO cars DOCUMENTS (:car)" --args '{"car":{"_id":"c1","make":"Toyota"}}'
cat batch.sql | dittosh server execute          # one HTTP call per statement
dittosh server execute "EXPLAIN SELECT * FROM orders WHERE store_id = 's1'"
```

Results render exactly like `dittosh dql` (table on TTY, JSON when piped, `-o`/`--format`/`--max-rows`/pager/`--time`). Mutations print `OK` and a `(transactionId … · N documents mutated)` note on stderr.

**Configuration** is resolved in this order (first hit wins):

1. **Flags:** `--url <url>` / `--api-key <key>`
2. **Shell env:** `DITTOSH_SERVER_URL` / `DITTOSH_SERVER_API_KEY` (aliases from the Ditto docs also work: `DITTO_CLOUD_URL` / `DITTO_API_KEY`)
3. **A `.env` file in the current directory** (never overrides the real environment)

Find the URL in the portal → your app → "Connecting via HTTP" → **Cloud URL Endpoint** (looks like `xxxx.cloud.dittolive.app/<app-id>`). Create API keys in the portal → your app → **Auth → New API key**. Prefer env/`.env` over `--api-key` — argv is visible in `ps` and shell history. The URL must be `https://` (cleartext `http://` is rejected for non-local hosts; loopback is exempt for local testing).

| Command | What it calls |
|---|---|
| `server execute [statement]` (alias `exec`) | `POST /api/v5/store/execute` — any DQL: SELECT/INSERT/UPDATE/DELETE/EXPLAIN/…; `-e`/`-f`/stdin batch, `-p`/`--args`, `--txn-id`, `--api-version v4\|v5`, `--timeout` (default 120s) |
| `server remote-execute <statement>` | `POST /api/v5/sync/remote_execute` — run DQL on connected edge peers (statement must start with `SYNC CONTEXT`) |
| `server attachment upload <file>` / `get <id>` | `POST /api/v4/attachments/upload` (multipart) / `GET /api/v4/attachments/{id}` (raw bytes; refuses to dump binary to a terminal — use `-o` or pipe) |
| `server roles list/create/delete` | `/api/v4/auth/roles` — Big Peer RBAC roles (portal-internal API) |
| `server users list/set-roles/delete` | `/api/v4/auth/users` — app users and their role sets (portal-internal API) |
| `server webhook-secrets list/create/rotate/delete` | `/api/v4/auth/webhook/secret` — auth-webhook HMAC secrets (portal-internal API) |
| `server doctor` | config → connection → auth probe; exit 3 on any failure |

The legacy pre-DQL store API (`find`/`findbyid`/`count`/`write`) is deliberately not supported — `server execute` covers it with full DQL. Every command's `--help` documents its request body and examples (the RBAC/webhook endpoints aren't publicly documented — the help text is the reference). Batch mode: auth/connection failures stop the batch with exit 3 even under `--continue-on-error`; a timeout does *not* mean the statement failed — a mutation may still commit server-side.

### Global flags

`--no-color`, `--quiet` (suppress informational notes), `--no-update-check` (planned; update flow lands in a later milestone).

### `dittosh skills` — install the DQL agent skill for AI coding agents

```bash
dittosh skills add                    # install the dql skill into all detected agents (global)
dittosh skills add --project .        # project-local install
dittosh skills add --agent claude,opencode   # specific agents
dittosh skills list                   # what's installed where (with upstream ref)
dittosh skills update                 # refresh installed skills from the latest upstream release
```

Mirrors the Android CLI's `android skills add` semantics: default skill is `dql`, global scope unless `--project <path>`, all detected agents unless `--agent <list>`. Targets: Claude Code (`~/.claude/skills/dql` or `.claude/skills/dql`), OpenCode (`~/.agents/skills/dql` or `.agents/skills/dql`), Codex (`~/.codex/skills/dql`), Gemini (`~/.gemini/skills/dql`), Cursor (`.cursor/rules/dql`, project-only), Copilot + Windsurf (project instruction files). While `getditto/agent-skills` is private, set `GITHUB_TOKEN` (e.g. `GITHUB_TOKEN=$(gh auth token)`).

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
| 1 | query/DQL error · server API error · server timeout (`server`) |
| 2 | usage error (bad flags, missing file, ambiguous dataset query, …) |
| 3 | platform/token/data-dir problem (unsupported OS/arch, expired license, unwritable dir) · server config missing/invalid, auth rejected, or unreachable (`server`) |
| 4 | data directory locked by another process |

## REPL

Bare `dittosh dql` starts an interactive session: multi-line statements terminated with `;`, history, per-statement timing, dot-commands (`.help`, `.collections`, `.indexes [name]`, `.break`, `.exit`).

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
