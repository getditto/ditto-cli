# SDKS-4855: Implementation plan — `ditto` CLI

Companion to the canonical spec: [`SDKS-4855-dql-cli-tool.md`](./SDKS-4855-dql-cli-tool.md).
Branch: `aaronlabeau/sdks-4855-dql-cli-tool`. This file is the working checklist; tick boxes as work lands.

## Sequencing approach

**Walking skeleton first, risk-first ordering.** Get `ditto dql "SELECT …" → table output` working end-to-end against a real Ditto store as early as possible (M1), then layer features in milestone order. The three riskiest unknowns are burned down before or during M1:

- **Spike A (M0):** verify SDK v5.1 construction + offline license flow from Node ESM — `Ditto.init()` → `new DittoConfig(appId, { mode: "smallPeersOnly" }, dir)` → `Ditto.open()` → `setOfflineOnlyLicenseToken(token)` → `store.execute("SELECT 1")`. Manual script, dev token, throwaway code. Also confirms the SDK loads from a tsup-bundled CLI (external dependency resolution when globally installed).
- **Spike B (M1):** persistence-lock error shape (`store/persistence-directory-locked`) so error mapping is based on the real error, not docs.
- **Spike C (M3):** real `~request_profile` envelope from the SDK vs. Edge Studio fixtures — reconcile parser assumptions before building the tree renderer.

**Prerequisite for any SDK-touching work:** ✅ dev token available in the repo-root `.env` (`DATABASE_ID`, `OFFLINE_TOKEN`, `EXPIRE_ON` — gitignored, loaded via `node --env-file`; `DQL_OFFLINE_LICENSE` remains the CI alias). Integration tests skip without it.

## Conventions

- ESM (`"type": "module"`), TypeScript strict, `module: "NodeNext"`, Node ≥ 20.
- Dev runner `tsx`; build `tsup` (bundle all except `@dittolive/ditto`); `vitest` (unit/integration/e2e projects); `biome` lint+format; `execa` for e2e.
- Runtime deps only: `@dittolive/ditto`, `commander`, `chalk`, `env-paths`, `@inquirer/prompts`, `tar`. No table/tree deps — hand-rolled.
- Errors: never print raw stack traces to users; typed `CliError` with exit code + actionable message.
- No color when `NO_COLOR`, `CI`, `--no-color`, or non-TTY.
- Update `AGENTS.md` (create in M0) whenever build/test/release conventions change.

---

## M0 — Scaffold

**Goal:** installable dev shell with namespaced command registry; no Ditto yet.

- [x] `package.json` — name `@dittolive/cli`, `bin.ditto → dist/cli.js`, `type: module`, `engines.node >=20`, `os`/`cpu` restrictions, `files: ["dist"]`, scripts: `dev` (tsx + `--env-file=.env`), `typecheck`, `test` _(build/lint scripts + tsup/biome/vitest configs still to add)_
- [x] `tsconfig.json`, `.gitignore` (incl. `.env`, `build/token-chunks.ts`, `dist/`) — _tsup/biome/vitest configs pending_
- [x] `vitest.config.ts` (projects: unit / integration [serial, 120s] / e2e) + `tests/setup/env.ts` (loads repo-root `.env`, `FORCE_COLOR=0`) + `tests/helpers/credentials.ts` (skip-gate + tmpdir helpers) — _tsup/biome configs pending_
- [x] `src/cli/registry.ts` — group/command registration API _(deferred — group modules register onto commander directly; extract a registry abstraction only if a third group needs it)_
- [x] `src/config/paths.ts` — `resolveDataDir(flag, env, platform)` + `configDir()` (lazy; `DITTO_CONFIG_DIR` test override)
- [x] `src/cli/groups/dql/` with `doctor` subcommand: platform/arch vs. SDK matrix, Node version, data-dir writability, token presence + expiry
- [x] Stub groups `skills` (add/update/list → "not yet implemented" exit 2) and `system` (`version` prints version/channel=dev/platform; `update` stub) — _partial: `ditto version` is commander's `--version`; skills/system groups land at M6/M7_
- [x] `AGENTS.md` — build/test/run conventions; README stub — _AGENTS.md done; README at M8_
- [x] `.github/workflows/ci.yml` — lint, typecheck, unit on macos/ubuntu/windows × Node 20/22/24; integration+e2e job (macOS, secrets-gated); bundle token-grep guard
- [x] tsup build: `dist/cli.js` ESM bundle w/ shebang + createRequire shim, `__CLI_VERSION__` + `RELEASE` defines; biome lint+format wired (`npm run lint`)

**Tests:** unit — paths precedence matrix (flag/env/default × platforms), registry routing, doctor check aggregation; e2e — `ditto dql doctor`, `ditto version`, unknown command → exit 2.
**Exit:** `npm run dev -- dql doctor` works; CI green.

## M1 — Core query

**Goal:** `ditto dql "SELECT …"` → table, against a real offline store.

- [x] Spike A + Spike B (above); record findings in this file
- [x] `src/identity/token.ts` — dev path: `RELEASE === false` → `DATABASE_ID`/`OFFLINE_TOKEN`/`EXPIRE_ON` from `.env` (aliases `DQL_OFFLINE_LICENSE`/`DITTO_APP_ID`); release path → reassemble from `build/token-chunks.ts` (module absent in dev; reassembly wired in M8). Expiry: `EXPIRE_ON` (dev) / parsed (release)
- [x] `src/ditto/session.ts` — `DittoSession.open({ dataDir, token })`: `Ditto.init()` (once, `Logger.enabled=false`), config/open, `setOfflineOnlyLicenseToken`, `execute(dql, args?)`; `close()`; lock-error mapping → exit 4 _(token-expiry preflight < 14d nag / expired exit 3 — pending)_
- [x] `src/query/execute.ts` — statement classifier (SELECT / EXPLAIN / PROFILE / ADVISE / DDL / mutation), result extraction (`items`, `dematerialize()` / zero-arg accessor), `MAX_ROWS` cap + truncation metadata
- [x] `src/render/table.ts` — string-width-aware table (`_id` first, union-of-keys columns, nested → compact JSON, attachment placeholder), truncation banner; JSON via auto-select (piped) or `--format json`
- [x] `ditto dql [statement]` + `-d/--data-dir`, `--format`, `--max-rows` (wired in `src/cli/index.ts`)
- [x] Integration test seed data: cookbook `movies` docs — `tests/integration/session.test.ts` + `tests/e2e/cli.test.ts` green: **61/61 (46 unit, 8 integration, 7 e2e)**

**Tests:** ✅ unit — classifier edge cases, extraction shapes, table snapshots, expiry parsing (46 tests); ✅ integration — open session in tmpdir, INSERT seed, SELECT assertions, params, EXPLAIN `plan` / PROFILE `~request_profile` structure, lock error on second open (8 tests); ✅ e2e — one-shot query, JSON piping, `--format table`, `--max-rows` banner, exit codes 0/1/2, doctor (7 tests). CI wiring (secret + matrix) pending.
**Exit:** `ditto dql "SELECT * FROM movies"` prints a table from a seeded store ✅ (manual + automated).

## M2 — Interactive & input modes

- [x] `src/query/split.ts` — statement splitter (`;` outside quotes/identifiers, `--`/`/* */` comments, blank-line tolerance)
- [x] `src/cli/groups/dql/repl.ts` — `node:repl`: multiline until `;` (Recoverable continuation prompt), history file under config dir, dot-commands `.help` `.collections` `.indexes [c]`; per-statement timing echo. _(TTY-only by design: piped stdin = batch mode. REPL verified manually — e2e has no pty.)_
- [x] `-f/--file` runner: split → execute sequentially → per-statement output; bail on first error by default, `--continue-on-error` override; summary footer (N ok, M failed)
- [x] stdin detection (`!isatty(0)` → read stdin as file input)
- [x] Params: `-p name=value` (repeatable; `JSON.parse` with string fallback) + `--args '<json>'`; bind to `:name`; usage errors → exit 2
- [x] `-o/--out <path>` — write results to file (format from extension or `--format`); stdout prints one-line summary; all non-result output stays on stderr (jq-safe piping)
- [x] No-LIMIT one-time warning — bare `SELECT` without `LIMIT` on a TTY warns once (persist `noLimitWarned` in config dir); points at `LIMIT`, `--max-rows`, `-o` _(TTY-gated; unit-adjacent, not e2e-covered — needs pty)_
- [x] `src/render/csv.ts` — RFC-4180-ish, union-of-keys header
- [x] `ditto dql collections` → `SELECT * FROM system:collections`; `ditto dql indexes [collection]` → `system:indexes` (WHERE when arg given)

**Tests:** ✅ unit — splitter corpus (11 cases), params (8), CSV (5), state store (4); ✅ integration — system:collections/system:indexes on seeded store (3); ✅ e2e — `-f` multi-statement, bail/`--continue-on-error`, stdin batch, `-p`/`--args`, `-o` CSV, usage errors (6). **100/100 green.**
**Exit:** ✅ all four input modes work.

## M3 — Sample datasets (`ditto dql dataset`)

**Goal:** vendored benchmark suites loadable as generated sample data; catalog queries runnable by name.

- [ ] `datasets/` at repo root, one module per suite — vendored from `getditto/dql-metrics-benchmark` (`benchmarks/{movies,retail,retail-joins,pos}/`): collection shapes, setup DDL (the suites' index statements), query catalog (`<collection>__<op>__<variant>` → statement + category + description), generator descriptor. **No NDJSON committed** — generators only.
- [ ] `src/datasets/rng.ts` — mulberry32 seeded RNG + helpers (`int`, `pick`, `weighted`, `uuidv4-from-rng`, date walkers); determinism contract: same seed ⇒ identical docs (unit-tested)
- [ ] `src/datasets/generators/` — per-suite generators: `movies` (synthesize from field pools — the benchmark's 23,539-doc source corpus is 37 MB LFS, **not** vendored), `retail` (fixed stores/categories/products catalogs + customers/inventory/orders/order_items scaled by `--docs`), `retail-joins` (normalized variant + `product_types`), `pos` (locations, sale_items w/ modifier groups, pos_orders w/ money objects). Shape/distribution fidelity only — **no byte-parity claim**; expected counts only where fixed by construction
- [ ] `src/datasets/loader.ts` — batched insert (`INSERT … DOCUMENTS (deserialize_json(:doc))` style, 500–1000/batch), progress to stderr, `--seed` (default 42), `--docs`, `--batch-size`
- [ ] Commands: `ditto dql dataset list | show <name> | load <name> | run <query> [--dataset] [--setup] | reset <name>`; `run` prints the resolved statement first, then standard result pipeline (`--time`/`--explain`/`--profile`/`-o` compose); write-category catalog queries require `--yes`
- [ ] `reset` = EVICT all docs in the dataset's collections

**Tests:** unit — RNG determinism, generator shape/referential-integrity invariants per suite, catalog name resolution + ambiguity errors, statement printing; integration — `dataset load movies --docs 100` in tmpdir, run `movies__select__single_result`-style catalog queries, `reset` empties collections; e2e — `dataset list`/`show`/`run` output.
**Exit:** `ditto dql dataset load retail --docs 1000` then `ditto dql dataset run stores__select__by_location_city` prints the statement and a populated table.

## M4 — Time / Explain / Profile

- [ ] Spike C: run `PROFILE SELECT …` against real SDK, capture envelope, compare to Edge Studio fixture; adjust model
- [ ] `src/profile/parse.ts` — `~request_profile` detection (wrapped + bare form via marker fields: `times`/`queryType`/`requestType`/`featureFlags`/`state`/`resultCount`, deliberately not `text`), tolerant optional fields, `QueryProfile` model
- [ ] `src/profile/formatNs.ts` — exact Edge Studio rules; `percentOfTotal(ns, total, 0.05)`; hotspot = exec ≥ 50% of subtree-total exec
- [ ] `src/render/profileTree.ts` — header (query, captured time), summary strip (Elapsed/Parse/Plan/Result count/QueryType), ASCII tree (`├──`/`└──`, per-node `operator keyAttr ── exec (pct) ── N in / M out`, `▲` hotspot marker), legend footer
- [ ] `src/render/explain.ts` — pretty JSON w/ chalk highlighting; tree form when operators recognizable; raw fallback always
- [ ] `--time` — `performance.now()` around execute; footer line; merges server-side times when profile present
- [ ] Execution gating (Edge Studio rules): PROFILE prefix only for bare SELECT; never `PROFILE PROFILE`; no EXPLAIN side-trip on ADVISE/EXPLAIN-typed statements; non-SELECT + `--profile` → "only SELECT statements are profilable" note
- [ ] Copy Edge Studio profile fixtures into `tests/unit/fixtures/`

**Tests:** unit — parser vs. fixtures + Spike-C real capture, formatNs boundaries, hotspot math, tree snapshots, gating matrix; integration — live EXPLAIN/PROFILE parse round-trip; e2e — `--profile` output contains summary strip + tree.
**Exit:** `ditto dql --profile "SELECT …"` renders the full profile view.

## M5 — Advise

- [ ] `src/query/advise.ts` — wrap in `ADVISE <stmt>`; forgiving extraction (scan rows, merge `advice.suggestedIndexes[]`, drop partials missing `collection`/`statement`); empty → `outcome` text
- [ ] `src/render/advise.ts` — "Index advice" section: analyzed statement; per suggestion `collection — reason` + CREATE INDEX in code block
- [ ] `--apply` flow: `@inquirer/prompts` confirm per statement (or `-y`), execute via raw path, per-statement `created | failed` report
- [ ] Gating: `--advise` + `--profile`/`--explain` together → advise wins, warn once

**Tests:** unit — extraction fixtures (suggestions, no-keys outcome, partial drops); integration — live `ADVISE` on unindexed query, then `--apply -y`, then `ditto dql indexes` shows it; e2e — advice output format.
**Exit:** `ditto dql --advise "SELECT …"` prints advice; `--apply` creates the index.

## M6 — Skills (`ditto skills`)

- [ ] `src/skills/github.ts` — resolve ref (latest release via `repos/getditto/agent-skills/releases/latest`, fallback `main`); tarball via codeload; `GITHUB_TOKEN` auth header; 401/404 → "repo is private / not yet public — set GITHUB_TOKEN" guidance
- [ ] `src/skills/fetch.ts` — stream tarball → `tar` extract filter `skills/<name>/**` → staging tmpdir; integrity: record resolved ref/sha
- [ ] `src/skills/agents.ts` — registry: claude-code (`~/.claude/skills` | `.claude/skills`), opencode (`~/.agents/skills` | `.agents/skills`), codex (`~/.codex/skills`), gemini (`~/.gemini/skills`), cursor (`.cursor/rules`, project-only), copilot + windsurf (project instruction files); detection = presence of global dir or project markers
- [ ] `src/skills/install.ts` — copy tree (Windows-safe, no symlinks), write `.dql-skill.json` marker `{ skill, ref, installedAt, channel }`; overwrite prompt on existing install unless `--force`
- [ ] Commands: `add` (`--skill dql` default, `--all`, `--agent` csv, `--project <path>`), `update` (re-fetch + compare marker, report per-target), `list` (scan targets, print table)
- [ ] `--dry-run` on add/update

**Tests:** unit — agent detection on fixture home/project dirs, target-path matrix incl. Windows paths, marker read/write, `--dry-run` no side effects; installer against fixture tarball via mocked fetch (nock-style `fetch` stub); e2e — `skills add --project <tmp>` from a local fixture server/tarball, `skills list` shows it.
**Exit:** `ditto skills add --project .` installs the dql skill; real GitHub path manually verified with `GITHUB_TOKEN`.

## M7 — Self-update

- [ ] `src/update/check.ts` — registry `latest` for `@dittolive/cli`; cache `{ checkedAt, latest }` in config dir, 24h TTL; failures silent; opt-outs: `CI`, `DITTO_NO_UPDATE_CHECK`, `--no-update-check`, non-TTY, `--format json`
- [ ] `src/update/banner.ts` — one-line notice after command output (stderr), box style consistent with render layer
- [ ] `src/update/channel.ts` — channel detection: realpath of argv entry under Homebrew Cellar/`brew --prefix` → `brew`; under `npm prefix -g` → `npm`; else `unknown`
- [ ] `src/cli/groups/system/update.ts` — dispatch `brew update && brew upgrade ditto` | `npm i -g @dittolive/cli@latest` (spawn, inherit stdio); `unknown` → print both manual commands; never self-elevate
- [ ] `ditto version` — version, channel, token expiry, data dir, platform/arch, Node version

**Tests:** unit — cache TTL/etag-ish logic, semver compare, all opt-out paths, channel detection from fixture paths, banner suppression matrix; e2e — `version` fields, banner absent in JSON mode (stub registry via env override for test).
**Exit:** banner appears on simulated outdated install; `ditto update` dry-verified on both channels.

## M8 — Distribution & release

- [ ] `scripts/stamp-token.ts` — reads `DQL_OFFLINE_LICENSE`; salt → key → XOR → 7 chunks + 5 decoys at fixed positions → base64url → `build/token-chunks.ts`; expiry guard: fail < 45 days, warn < 90 days (JWT `exp`, `--expires` override for non-JWT formats)
- [ ] Release build mode: `RELEASE=true` define; verify dev token env is dead in release bundle (e2e asserts env ignored)
- [ ] `.github/workflows/release.yml` — on `v*` tag: full test matrix → stamp → build → `npm publish --provenance` → GitHub release → formula bump job
- [ ] `scripts/bump-formula.ts` + `getditto/homebrew-tap` `Formula/ditto.rb` template — npm tarball URL + sha256, `depends_on "node"`, test block (`ditto version`); bump opens PR or direct-commits (decide with repo owners)
- [ ] `.github/workflows/token-expiry.yml` — weekly cron; < 90 days → maintainer alert
- [ ] README — install (npm/brew), quickstart, all flags, skills usage, platform matrix, token-expiry explainer
- [ ] `npm pack` dry-run audit (no raw token strings in tarball — CI step greps the bundle for the token and fails on match)

**Tests:** unit — stamp-token round-trip vs. runtime reassembly, expiry guard thresholds, formula rendering; CI — release dry-run on pre-release tag; manual — `brew install` from tap on macOS + Linuxbrew, `npm i -g` on all three OSes, smoke `ditto dql doctor`.
**Exit:** v1.0.0 published to npm + Homebrew; token-expiry grep clean.

---

## Cross-cutting checklist (every milestone)

- [ ] Exit codes honored: 0 ok · 1 query/DQL · 2 usage · 3 platform/token · 4 lock
- [ ] `--no-color`/`NO_COLOR`/`CI` respected; piped → JSON where applicable
- [ ] No secrets in logs/errors; token never printed (even `--verbose`)
- [ ] New commands registered via registry with help text
- [ ] Tests: unit ≥ the logic, integration where SDK touches, e2e for every user-facing command

## Dependencies tracker

| # | Dependency | Blocks | Owner | Status |
|---|-----------|--------|-------|--------|
| 1 | Official offline token + app ID from license ops | M8 (release only) | PM/license ops | open |
| 2 | Dev token locally + CI secret | M1 integration | maintainer | ✅ `.env` in repo root (gitignored); CI secret still to add |
| 3 | `getditto/agent-skills` public (or `GITHUB_TOKEN`) | M6 real-fetch | PM | open (token workaround) |
| 4 | `getditto/homebrew-tap` repo | M8 | maintainer | open |
| 5 | `@dittolive` npm scope publish rights | M8 | maintainer | open |
| 6 | `getditto/dql-metrics-benchmark` suite drift | M3 (manual sync) | maintainer | accepted — vendored copy |

## Spike findings log

- **Spike A (v5.1 init + offline token):** ✅ PASS (2026-08-29, `scripts/spike-a.mjs`). `sdk.init()` → `new DittoConfig(appId, { mode: "smallPeersOnly" }, storeDir)` → `Ditto.open(config)` → `setOfflineOnlyLicenseToken(token)` all work on `@dittolive/ditto@5.1.0` with the dev offline playground token. INSERT with `COLLECTION … (field MAP/COUNTER)` + `ON ID CONFLICT DO UPDATE` ✅, parameterized SELECT ✅, `EXPLAIN` returns first item keyed `plan` ✅, `PROFILE` appends trailing item keyed `~request_profile` ✅, `close()` clean ✅. **Gotcha:** SDK emits verbose INFO/WARN logs on open — the CLI must set the SDK log level to error-only (investigate `DittoLogger`/env) so output stays pipeable.
- **Spike B (lock error shape):** ✅ PASS (2026-08-29). Two processes on one data dir: second `Ditto.open` throws with message containing "File already locked" — mapped to exit code 4 with an actionable message ("The data directory is in use by another ditto process: <path> …").
- **Spike C (real profile envelope vs. fixture):** _pending — Spike A confirmed trailing key `~request_profile`; full field capture happens here_
- **Known cosmetic issue:** the native tracing bootstrap writes ~7 WARN/INFO lines to stderr at `sdk.init()` via fd-level writes — not suppressible from JS (`Logger.enabled=false` kills all open-time logs; `RUST_LOG`/`DITTO_LOG` ignored). stdout stays pure, piping unaffected. Possible SDK-team follow-up.
