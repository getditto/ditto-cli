# SDKS-4855: `ditto` CLI — DQL command-line tool (first command group: `ditto dql`)

**Linear:** [SDKS-4855](https://linear.app/ditto/issue/SDKS-4855/dql-cli-tool) (full spec posted as a single consolidated comment)
**Status:** Spec — in implementation
**Tracking:** this file is the canonical spec (no GitHub issue exists in this repo; `plans/` is the tracking surface)

---

## Summary

An installable TypeScript CLI invoked as **`ditto`** — a single, extensible command-line tool for Ditto. **DQL is the first command group**: everything designed for query execution lives under `ditto dql …` (e.g. `ditto dql doctor`, `ditto dql collections`), leaving room for future feature groups (`ditto sync …`, `ditto skills …`, etc.) instead of shipping multiple tools. Rich terminal output for results, timing, EXPLAIN, PROFILE, and ADVISE; **built-in sample datasets** (movies, retail, retail-joins, pos — vendored from the private `dql-metrics-benchmark` suites) generated on the fly so users can load realistic data and run curated example queries; and a `skills` group that installs the DQL agent skill from `getditto/agent-skills` into AI coding agents, mirroring `android skills add` semantics.

**Locked-down identity (manager decision):** the CLI ships with a single Ditto-issued **offline license token** baked into the release. Users cannot supply their own token or app ID. Sync is never started. The token is **obfuscated** in the shipped bundle (reversible transform — see [Token obfuscation](#4-token-obfuscation)), expires roughly **every 6 months**, and is rotated by cutting a new release (the self-update feature is the rotation delivery mechanism). PM has accepted the risk of the token leaking — obfuscation exists only to defeat casual extraction, not determined attackers.

**Naming & install paths:**
- npm package: **`@dittolive/cli`** (both `ditto` and `ditto-cli` are taken on npm; the `@dittolive` scope is available) with binary name **`ditto`** → `npm i -g @dittolive/cli`
- Homebrew: `brew install getditto/tap/ditto` (new `getditto/homebrew-tap` repo, formula `ditto.rb`)

**Install-time collision note:** if a user already has another `ditto` binary on PATH (the npm stub, the file-comparison tool, etc.), npm/brew will warn; docs should cover PATH ordering. Accepted risk.

---

## Requirements

### 1. Query execution (`ditto dql`)

- One-shot: `ditto dql "SELECT * FROM movies WHERE year = 1994"`
- File: `ditto dql -f script.dql` (statements split on `;`, executed one per `store.execute` call — the SDK requires one statement per call, no trailing `;`)
- Piped stdin: `echo "SELECT * FROM movies" | ditto dql`
- Interactive REPL: bare `ditto dql` — readline history, `.help`, `.collections`, `.indexes <collection>`, `.exit`; multi-line statements terminated by `;`
- Parameter binding: `-p name=value` (repeatable, values JSON-parsed with string fallback) or `--args '<json-object>'`, bound to `:name` placeholders
- Result caps: `--max-rows` (default 10,000; display only — `-o` file exports are uncapped unless `--max-rows` is explicit), truncation banner "showing first N of M rows — add a LIMIT clause"
- **Output to file:** `-o/--out <path>` writes results in the selected `--format` (default inferred from extension: `.json`, `.csv`, anything else → table text); stdout prints a one-line summary ("Wrote 1,234 rows to results.json in 12 ms")
- **Piping:** when stdout is not a TTY, output auto-selects JSON so results compose cleanly with tools like `jq` (`ditto dql "SELECT * FROM stores" | jq '.[] | .store_name'`). Progress, warnings, and errors always go to **stderr**, never stdout
- **No-LIMIT warning:** the first time a user runs a bare `SELECT` without a `LIMIT` clause on a TTY, print a one-time warning that unbounded queries can return very large result sets, pointing at `LIMIT`, `--max-rows`, and `-o`. A `noLimitWarned` flag is persisted in the config dir so it fires once per user; statements with `LIMIT` or an explicit `--max-rows` never trigger it

### 2. Sample datasets (`ditto dql dataset`)

Built-in, on-the-fly generated sample datasets so users can explore DQL against realistic data without connecting anything. **Vendored from the private `getditto/dql-metrics-benchmark` repo** (`benchmarks/{movies,retail,retail-joins,pos}/`): the tool is public and the benchmark repo is private, so the suite definitions are copied into this repo (`datasets/` at repo root) rather than fetched at runtime. Accepted trade-off (on record): if the benchmark suites change upstream, this copy must be updated manually.

**Principles:**
- **Nothing pre-generated ships in the package** — no NDJSON fixtures, no git LFS. Data is generated in memory at load time by TypeScript generators with a seeded RNG (deterministic for a given `--seed`), and inserted in batched `INSERT … DOCUMENTS (…) ON ID CONFLICT DO UPDATE` statements (~500–1000 docs per batch) with progress on stderr.
- **Shape/distribution fidelity, not byte parity.** Generators follow the benchmark suites' schemas, value distributions, and referential integrity, but use our own seeded RNG (mulberry32) — generated bytes do **not** match the benchmark repo's Python-generator fixtures, and benchmark `expected_count` values are not claimed except where counts are fixed by construction (stores=8, categories=9, locations=7, sale_items=47, products=400).
- Each dataset definition in `datasets/<name>/` declares: collection shapes (field docs), **setup statements** (the suites' `CREATE INDEX` DDL), the **query catalog** (vendored `<collection>__<op>__<variant>` names → DQL statement + category + description), and the **generator** (scaling dimension + per-collection generator functions).

**Datasets and scaling dimensions** (`--docs` targets the scaling dimension; related collections scale proportionally with the suite's ratios):
- `movies` — single collection, composite `_id` object, `_id.year` is a string; scaling dimension = movie count (default 10,000)
- `retail` — 7 denormalized collections (stores, categories, products, customers, inventory, orders, order_items); scaling dimension = order count (default 5,000)
- `retail-joins` — retail normalized + `product_types`, denormalized fields stripped to force JOINs (default 5,000 orders)
- `pos` — locations, sale_items, pos_orders with money objects, modifier groups, status/payment enums; scaling dimension = order count (default 5,000)

**Commands:**
```
ditto dql dataset list                        # available datasets: collections, query counts, default size
ditto dql dataset show <name>                 # shapes, setup indexes, full query catalog
ditto dql dataset load <name> [--docs N] [--seed N] [--batch-size N]   # generate + insert
ditto dql dataset run <query-name> [--dataset <name>] [--setup]        # run a catalog query
ditto dql dataset reset <name>                # EVICT all docs from the dataset's collections
```

- `dataset run` prints the resolved statement first ("Running `stores__select__by_location_city`: `SELECT * FROM stores WHERE location.city = 'Seattle' AND deleted = false`"), then executes through the standard result pipeline (table/JSON, `--max-rows`, `-o`, `--time`/`--explain`/`--profile` all compose). Query names resolve across all datasets; ambiguous names produce an error listing the matches with their dataset. `--setup` runs the catalog entry's index DDL (the suites' `preQueries`) before the query.
- `dataset run` with a write-category query (INSERT/UPDATE/DELETE/EVICT/UPSERT) requires `--yes` confirmation since it mutates the store; the catalog entries' own reset/cleanup statements are applied around it.

### 3. Data directory

Resolution precedence: **`--data-dir` flag → `DITTO_DATA_DIR` env var → OS default** via `env-paths("ditto")`:
- macOS: `~/Library/Application Support/ditto`
- Linux: `~/.local/share/ditto`
- Windows: `%LOCALAPPDATA%\ditto`

Directory is created on demand; passed to `DittoConfig` as the persistence directory. A second process against the same data dir hits the SDK workspace lock → mapped to an actionable error ("another ditto process is using <path>").

### 4. Identity & offline-only lockdown

- `Ditto.init()` → `new DittoConfig(APP_ID, { mode: "smallPeersOnly" }, dataDir)` → `Ditto.open(config)` → `setOfflineOnlyLicenseToken(token)`. **Verified by Spike A (2026-08-29):** this exact flow works on `@dittolive/ditto@5.1.0` with an offline playground token — INSERT with CRDT type declarations, parameterized SELECT, `EXPLAIN` (first item key `plan`), and `PROFILE` (trailing `~request_profile` item) all confirmed against a real store.
- `startSync()` is **never called**. There is no `--sync` flag. Rationale: every install shares one app ID and one token — enabling sync would let two users on the same LAN sync each other's stores.
- No user-facing credential surface of any kind: no `--app-id`/`--license` flags, no `ditto config set`, no `DITTO_APP_ID` env var.
- **Dev/CI token:** a gitignored `.env` in the repo root with `DATABASE_ID`, `OFFLINE_TOKEN`, `EXPIRE_ON` (loaded via `node --env-file` / `process.loadEnvFile` in dev scripts only). `DQL_OFFLINE_LICENSE` accepted as a fallback alias for CI parity with agent-skills. Honored **only in dev/unbundled builds** (guarded by a build-time `RELEASE` constant); release builds ignore env credentials entirely.
- SDK logging: the SDK emits INFO/WARN logs on open (observed in Spike A); the CLI sets the SDK log level to error-only so stdout/stderr stay clean for result rendering and piping.

### 5. Token obfuscation

The PM accepts that the token may leak; the requirement is to make extraction **semi-difficult** — not greppable or visible via `strings` in the published tarball. This is obfuscation, explicitly **not** encryption, and is documented as such.

**Generation logic (release time, `scripts/stamp-token.ts`):**

```
inputs:  T = raw offline license token (from CI secret DQL_OFFLINE_LICENSE)
         S = crypto.randomBytes(16)            # per-release salt, shipped in bundle
         V = package version (e.g. "1.2.0")
1. key   = sha256(S || ":" || V || ":ditto-cli-token-v1")       # 32 bytes
2. X     = utf8(T) XOR key (key cycled over T)
3. split X into 7 chunks; interleave 5 decoy chunks (random bytes)
   at fixed documented positions P = {1, 4, 6, 9, 11}
4. base64url-encode each chunk
5. emit generated module build/token-chunks.ts:
     export const TOKEN_SALT = "<hex S>"
     export const TOKEN_CHUNKS = [c0, d0, c1, d1, ...]          # decoys inline
```

**Runtime reassembly (`src/identity/token.ts`):** drop decoy positions, un-permute, concat, base64url-decode, recompute `key` from bundled `S` + package `version` + scheme constant, XOR → raw token in memory only, never written to disk or logs.

- The generated chunks module is **build output, never committed** (`.gitignore`d); `S` changes every release, so chunk values churn completely between versions even for the same token.
- The scheme constant (`ditto-cli-token-v1`) allows algorithm rotation later without ambiguity.
- `scripts/stamp-token.ts` also **parses token expiry** and fails the release if the token expires in < 45 days (buffer for release lag), warning if < 90 days. CI additionally greps the packed tarball for the raw token and fails on any match.

### 6. Token expiry & rotation (6-month cycle)

- Offline tokens are issued with ~6-month validity.
- Rotation runbook: license ops issues new token → update `DQL_OFFLINE_LICENSE` CI secret → cut release → users pick it up via the update banner / `ditto update` / `brew upgrade`.
- **User-visible expiry:** `ditto version` and `ditto dql doctor` print the embedded token's expiry date; when < 14 days remain, every invocation prints a notice directing the user to update. Past expiry, the CLI exits with code 3 and an update instruction.
- Release automation warns maintainers when the current token is < 90 days from expiry (scheduled workflow job), so a rotation release is cut before expiry.

### 7. Diagnostics: timing, EXPLAIN, PROFILE, ADVISE (all under `ditto dql`)

Modeled on Ditto Edge Studio (`ditto-vsc-es`) information architecture, rendered for the terminal:

- **`--time`** — footer with host-side wall-clock (`performance.now()` around `store.execute`); when profiling data is available, also server-side parse/plan/elapsed.
- **`--explain`** — runs `EXPLAIN <stmt>` as a non-fatal side-trip; renders syntax-highlighted plan JSON (parsed into an indented tree when operators are recognizable; raw pretty JSON otherwise — upstream output shape is explicitly unstable). Spike A confirmed the first EXPLAIN item carries a `plan` key.
- **`--profile`** — prefixes `PROFILE` onto bare SELECTs only; never double-prefixes user-typed `PROFILE`. Parses the trailing `~request_profile` envelope (Spike A confirmed the trailing item key on 5.1.0): `times.{elapsed,parse,plan}` (ns), `resultCount`, `queryType`, `state`, recursive `plan` tree (`#operator`, `#stats.documentsIn/documentsOut`, `#stats.phaseTimes.exec/recv/send` ns, free-form attributes, `children`). Renders:
  - header (query text + captured time)
  - summary strip: Elapsed · Parse · Plan · Result count · QueryType
  - ASCII operator plan tree: per node `operator keyAttr ── exec (pct) ── N in / M out`
  - **hotspots** flagged (`▲`, colored) when exec ≥ 50% of plan-total subtree exec (Edge Studio's threshold)
  - legend footer explaining in/out/exec/recv/send
  - ns formatting identical to Edge Studio `formatNs` (≥1e6 ns → ms, ≥1e3 → µs, else ns)
- **`--advise`** — wraps statement in `ADVISE <SELECT>`; renders an "Index advice" section: analyzed statement, per suggestion `collection — reason` + ready-to-run `CREATE INDEX IF NOT EXISTS …`; `--apply` executes suggestions (interactive confirmation unless `-y`), reporting created/failed per statement. `ADVISE` never gets the PROFILE prefix or EXPLAIN side-trip (invalid syntax upstream).
- Non-SELECT statements under `--profile` print the "only SELECT statements are profilable" note, matching Edge Studio behavior.

### 8. Result rendering

- Default TTY: hand-rolled string-width-aware table — `_id` first column, union-of-keys columns, nested values as compact JSON, attachments as `[attachment id=… len=…]` placeholders (attachment bytes cannot flow through DQL)
- `--format json|csv|table`; piped/non-TTY output auto-selects JSON; `--no-color`, respects `NO_COLOR`/`CI`; `-o/--out <path>` writes to file (§1)
- Error rendering: DQL parse/execution errors with the statement excerpt and SDK error code

### 9. AI skills install (`ditto skills`)

Top-level group (skills are not DQL-specific long-term). Mirrors `android skills add` (`android/skills` repo semantics):

```
ditto skills add [--skill dql | --all] [--agent claude,opencode,codex,gemini,cursor,copilot,windsurf] [--project <path>]
ditto skills update        # refresh installed skills from upstream
ditto skills list          # show installed skills + versions per agent/location
```

- Default: `--skill dql` if neither `--skill` nor `--all` given (Android CLI installs its own skill by default; ours installs `dql`)
- Default scope: global (agent home dirs); `--project .` installs project-locally
- Default agents: all detected (presence of `~/.claude`, `~/.agents`/opencode config, `~/.codex`, `~/.gemini`, project markers); explicit `--agent` list overrides
- Install targets:
  - Claude Code: `~/.claude/skills/dql/` · project: `<project>/.claude/skills/dql/`
  - OpenCode / agentskills.io convention: `~/.agents/skills/dql/` · project: `<project>/.agents/skills/dql/`
  - Codex: `~/.codex/skills/dql/` · Gemini: `~/.gemini/skills/dql/`
  - Cursor: `<project>/.cursor/rules/dql/` (project-only where the agent has no global skill dir)
  - Copilot / Windsurf: project-level instruction-file emitters (`.github/copilot-instructions` style) where applicable
- **Source:** GitHub tarball of `getditto/agent-skills` at latest release tag (fallback `main`), extracting `skills/dql/`. `GITHUB_TOKEN` env honored for API auth while the repo is private; 401/404 produces guidance explaining the repo is not yet public / token needed. Installed metadata (source ref, date) recorded in a `.dql-skill.json` marker for `skills update`/`list`.
- Windows: copy files (no symlinks), per agent-skills README guidance.

### 10. Self-update (`ditto update`)

- **Update banner:** non-blocking check of npm registry `latest` for `@dittolive/cli`, cached 24h in the config dir; skipped when `CI`, `DITTO_NO_UPDATE_CHECK`, `--no-update-check`, non-TTY, or `--format json`.
- **`ditto update`:** detects install channel and dispatches —
  - Homebrew (resolved binary path under `$(brew --prefix)/Cellar`) → runs `brew update && brew upgrade ditto`
  - npm global (binary under `npm prefix -g`) → runs `npm i -g @dittolive/cli@latest`
  - Unknown → prints manual commands for both channels
- **`ditto version`:** version, install channel, embedded token expiry, data directory, platform/arch.
- Doubles as the token-rotation delivery mechanism (§6).

### 11. Platform support

Exactly the `@dittolive/ditto@5.1.0` native binary matrix (verified from the npm tarball): **macOS arm64, Linux x64, Linux arm64, Windows x64**. No darwin-x64 in 5.1.0 — `ditto dql doctor` and startup gate with a friendly unsupported-platform message. Node ≥ 22. `package.json` carries `os`/`cpu`/`engines` restrictions.

### 12. Distribution

- **npm** (primary): `@dittolive/cli`, tsup bundle (`dist/cli.js` + shebang), `@dittolive/ditto` external, `bin: { "ditto": "dist/cli.js" }`, `files: ["dist"]`.
- **Homebrew:** new `getditto/homebrew-tap` repo, `Formula/ditto.rb`: `depends_on "node"`, installs from published npm tarball URL with sha256 (`brew install getditto/tap/ditto`). Works on macOS + Linuxbrew.
- **Release automation (GitHub Actions on tag):** run tests → stamp obfuscated token from CI secret (with expiry guard, §5) → build → `npm publish` → open/land formula bump (URL + sha256) in the tap repo → create GitHub release with changelog.
- Scheduled workflow: weekly token-expiry check (< 90 days → maintainer alert issue/comment).
- Future (not this release): Scoop/winget; standalone binaries (pkg/Bun compile) once native `.node` loading story is solved.

---

## Command surface

```
ditto dql [statement]            # run statement, or enter REPL if omitted
  -f, --file <path>              # run statements from file
  -e, --execute <stmt>           # explicit statement form
  -p, --param name=value         # bind :name (repeatable); --args '<json>' alternative
  -d, --data-dir <path>          # override data directory
  -o, --out <path>               # write results to file (format from extension or --format)
      --format table|json|csv    # default: table in TTY, JSON when piped
      --time                     # timing footer
      --explain                  # rendered EXPLAIN plan
      --profile                  # PROFILE on bare SELECTs, rendered profile
      --advise [--apply|-y]      # index advice + optional CREATE INDEX execution
      --max-rows <n>             # default 10,000
      --no-color | --quiet
ditto dql doctor                 # platform/arch, SDK load, token validity+expiry, data-dir writability
ditto dql collections            # system:collections browser
ditto dql indexes [collection]   # system:indexes listing
ditto dql dataset list|show|load|run|reset   # sample datasets (§2)
ditto skills add|update|list     # see §9
ditto version                    # version, channel, token expiry, data dir
ditto update                     # self-upgrade via detected channel
      --no-update-check          # global flag: skip the update banner
```

Command registration is namespaced (`ditto <group> <command>`) so future groups (sync tooling, presence, attachments, …) slot in without restructuring.

Exit codes: `0` ok · `1` query/DQL error · `2` usage · `3` platform/token · `4` data-dir lock.

## Architecture (ESM TypeScript, Node ≥ 22)

```
datasets/                 # vendored suite definitions (no generated data committed)
├── movies/suite.ts       #   shapes, setup DDL, query catalog, generator descriptor
├── retail/suite.ts
├── retail-joins/suite.ts
└── pos/suite.ts
src/
├── cli/
│   ├── index.ts           # entry, global flags, update banner hook, exit codes
│   ├── registry.ts        # group/command registration (extensibility point)
│   └── groups/
│       ├── dql/           # exec/repl/file, doctor, collections, indexes, dataset subgroup
│       ├── skills/        # add, update, list
│       └── system/        # version, update
├── config/    # data-dir + config-dir resolution (env-paths), update-check + one-time-warning flags
├── identity/  # embedded-token reassembly (§5), expiry parsing, dev-token guard
├── ditto/     # DittoSession: init/open/close, SDK log-level taming, lock errors, execute() wrapper
├── query/     # statement classifier (SELECT/PROFILE-safe/ADVISE/EXPLAIN rules),
│              #   param binding, result extraction (items|dematerialize|accessor), row cap, no-LIMIT warning
├── datasets/  # seeded RNG, batch inserter, loader/runner for datasets/ suites
├── profile/   # ~request_profile parser, formatNs, hotspot computation
├── render/    # table, JSON, CSV, explain tree, profile ASCII tree, advise card, chalk colors
├── skills/    # GitHub fetch/tar extract, agent detection, global/project installers
└── update/    # registry check + 24h cache, channel detection, upgrade dispatch
scripts/
├── spike-a.mjs     # SDK init/token/DQL verification (done — passing)
└── stamp-token.ts  # release-time token obfuscation (§5), expiry guard
tests/
├── unit/       # no SDK required
├── integration/# real offline Ditto, temp dirs, cookbook + dataset data
└── e2e/        # execa against built bundle
```

**Dependencies (lean):** `@dittolive/ditto`, `commander`, `chalk`, `env-paths`, `@inquirer/prompts`, `tar`. Table/tree renderers hand-rolled (snapshot-testable). Dataset generators are dependency-free TS (own seeded RNG + name/word pools — **no Faker**, to stay deterministic and lean). Global `fetch` for HTTP.
**Build:** tsup → single bundle, Ditto external. **Tooling:** biome (lint+format), vitest.

## Testing

- **Unit (no SDK):** command registry routing (`ditto dql …` vs future groups); data-dir precedence; statement classifier edge cases lifted from Edge Studio (`PROFILE PROFILE`, `EXPLAIN ADVISE`, comment-leading queries); profile parser vs. real `~request_profile` fixtures (from `ditto-vsc-es` test fixtures + Spike A capture); `formatNs`; hotspot math; table/tree snapshots; dataset generators (seeded determinism — same seed ⇒ identical docs, referential integrity, fixed-catalog counts: stores=8, categories=9, locations=7, sale_items=47, products=400); skills installer (mocked fetch + fixture tarballs); agent detection (fixture home dirs); update cache logic; channel detection; token reassembly round-trip vs. `stamp-token.ts`; expiry parsing; `-o` file writer; no-LIMIT warning trigger/persistence.
- **Integration (real SDK, offline, tmpdir):** seed cookbook **movies/reviews** docs; parameterized queries; counter increment; `CREATE INDEX`; EXPLAIN/PROFILE/ADVISE parse validation; `dataset load movies --docs 100` then catalog queries return sane rows. Requires `OFFLINE_TOKEN`/`DATABASE_ID` (`.env` locally, CI secret); skipped without it.
- **E2E (execa on built bundle):** one-shot/`-f`/stdin/REPL via the `ditto dql` namespace, exit codes, `--data-dir` isolation, update-banner opt-outs, version/doctor output, dataset list/show/load/run.
- **CI:** GitHub Actions matrix — macos-latest (arm64), ubuntu-latest, windows-latest × Node 22/24. Release dry-run job validates stamp-token + formula-bump steps on pre-release tags.

## Milestones

| # | Milestone | Exit criteria |
|---|-----------|----------------|
| M0 | Scaffold | tsup/biome/vitest wired; commander shell with namespaced group registry; `ditto dql doctor` (platform+data-dir checks); CI skeleton |
| M1 | Core query | data-dir precedence; DittoSession w/ offline token (Spike A ✅); `ditto dql` one-shot + table/JSON; integration smoke test |
| M2 | Interactive | REPL (`.help`/`.collections`/`.exit`); `-f`; params; CSV; stdin; `-o/--out`; no-LIMIT warning |
| M3 | Datasets | `datasets/` vendored suites (movies, retail, retail-joins, pos); TS generators (seeded, batched insert); `dataset list/show/load/run/reset` |
| M4 | Time/Explain/Profile | parsers + renderers + hotspot tree; fixture-driven unit tests green |
| M5 | Advise | advice renderer + `--apply` with confirmation |
| M6 | Skills | `ditto skills add/update/list`: fetch/extract, agent detection, global/project install; works with `GITHUB_TOKEN` on private repo |
| M7 | Self-update | banner + cache + opt-outs; `ditto update` channel dispatch; `ditto version` |
| M8 | Distribution | `stamp-token.ts` + expiry guard; npm publish automation (`@dittolive/cli`); `getditto/homebrew-tap` + `ditto.rb` formula bump; README; GA release |

## Dependencies

1. **Official offline license token + dedicated app ID from license ops** — not available today; blocks only release stamping (M8); dev/CI use the local `.env` (`DATABASE_ID`/`OFFLINE_TOKEN`) meanwhile.
2. **`getditto/agent-skills` repo made public** — skills install works with `GITHUB_TOKEN` meanwhile.
3. **`getditto/homebrew-tap` repo creation** — needed at M8.
4. **npm org access for `@dittolive/cli`** — publish rights to the `@dittolive` scope.
5. **`getditto/dql-metrics-benchmark` stays private** — no runtime dependency; suite definitions are vendored into `datasets/` (manual upstream sync, on record).

## Open items

- **Repo rename:** this repo is currently `dql-cli`; rename to `ditto-cli` (or similar) to match the tool identity. Does not block implementation.
- **Homebrew formula name `ditto`** may shadow/conflict for users with other `ditto` binaries — document PATH guidance.

## Risks / decisions on record

- Token obfuscation is **deliberately casual** — PM accepted leak risk; scheme constant allows future algorithm rotation.
- **Token expiry cadence:** releases must stay ahead of 6-month expiry; stamp script hard-fails < 45 days, weekly automation warns < 90 days, users see expiry in `version`/`doctor` and a forced notice < 14 days.
- **Shared app ID ⇒ sync is a data-leak vector** ⇒ sync locked off; any future sync feature requires revisiting the identity model first.
- **Dataset vendoring is a manual mirror** of `dql-metrics-benchmark` — upstream drift requires a manual copy update (accepted). Generators are shape/distribution-faithful, not byte-parity; benchmark `expected_count` values are only surfaced where size-independent.
- **No darwin-x64** in SDK 5.1.0 — gated error message.
- **Attachments can't flow through DQL** — placeholders only; upload/download out of scope.
- **One process per data dir** (persistence lock) — actionable error, exit code 4.
- EXPLAIN/PROFILE output shape is **not a stable upstream contract** — parsers are tolerant (bare-envelope detection, optional stat fields), raw JSON fallback always available.
