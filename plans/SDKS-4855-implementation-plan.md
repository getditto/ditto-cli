# SDKS-4855: Implementation plan — `ditto` CLI

Companion to the canonical spec: [`SDKS-4855-dql-cli-tool.md`](./SDKS-4855-dql-cli-tool.md).
Branch: `aaronlabeau/sdks-4855-dql-cli-tool`. This file is the working checklist; tick boxes as work lands.

## Status summary

- **M0–M5 complete** (scaffold, core query, interactive modes, datasets, diagnostics, advise).
- **Adversarial review: 17 rounds, ~161 issues found and fixed, CONVERGED** (final round returned "no issues found"). Every fix carries regression tests; every round verified fixes live (incl. pty-level REPL checks).
- Two upstream SDK 5.1.0 bugs found and reported on the Linear ticket (NO_COLOR native panic; retail-joins query hang) — both mitigated CLI-side, see Known issues.
- Current: **392/392 tests green · coverage 89.3/86.7/90.6/89.9 (85% hard gate) · lint + typecheck clean.**
- M6/M7/M8 landed since; **M9 (`dittosh server`, portal HTTP API) landed on branch `portal-support`** — see the M9 section.
- Remaining: M8 loose ends (release.yml, formula, README).

## Sequencing approach

**Walking skeleton first, risk-first ordering.** Get `ditto dql "SELECT …" → table output` working end-to-end against a real Ditto store as early as possible (M1), then layer features in milestone order. The three riskiest unknowns are burned down before or during M1:

- **Spike A (M0):** verify SDK v5.1 construction + offline license flow from Node ESM — `Ditto.init()` → `new DittoConfig(appId, { mode: "smallPeersOnly" }, dir)` → `Ditto.open()` → `setOfflineOnlyLicenseToken(token)` → `store.execute("SELECT 1")`. Manual script, dev token, throwaway code. Also confirms the SDK loads from a tsup-bundled CLI (external dependency resolution when globally installed).
- **Spike B (M1):** persistence-lock error shape (`store/persistence-directory-locked`) so error mapping is based on the real error, not docs.
- **Spike C (M3):** real `~request_profile` envelope from the SDK vs. Edge Studio fixtures — reconcile parser assumptions before building the tree renderer.

**Prerequisite for any SDK-touching work:** ✅ dev token available in the repo-root `.env` (`DATABASE_ID`, `OFFLINE_TOKEN`, `EXPIRE_ON` — gitignored, loaded via `node --env-file`; `DQL_OFFLINE_LICENSE` remains the CI alias). Integration tests skip without it.

## Conventions

- ESM (`"type": "module"`), TypeScript strict, `module: "NodeNext"`, Node ≥ 22.
- Dev runner `tsx`; build `tsup` (bundle all except `@dittolive/ditto`); `vitest` (unit/integration/e2e projects); `biome` lint+format; `execa` for e2e.
- Runtime deps only: `@dittolive/ditto`, `commander`, `chalk`, `env-paths`, `@inquirer/prompts`, `tar`. No table/tree deps — hand-rolled.
- Errors: never print raw stack traces to users; typed `CliError` with exit code + actionable message.
- No color when `NO_COLOR`, `CI`, `--no-color`, or non-TTY.
- Update `AGENTS.md` (create in M0) whenever build/test/release conventions change.

---

## M0 — Scaffold

**Goal:** installable dev shell with namespaced command registry; no Ditto yet.

- [x] `package.json` — name `@dittolive/cli`, `bin.ditto → dist/cli.js`, `type: module`, `engines.node >=22`, `os`/`cpu` restrictions, `files: ["dist"]`, scripts: `dev` (tsx + `--env-file=.env`), `typecheck`, `test` _(build/lint scripts + tsup/biome/vitest configs still to add)_
- [x] `tsconfig.json`, `.gitignore` (incl. `.env`, `build/token-chunks.ts`, `dist/`) — _tsup/biome/vitest configs pending_
- [x] `vitest.config.ts` (projects: unit / integration [serial, 120s] / e2e) + `tests/setup/env.ts` (loads repo-root `.env`, `FORCE_COLOR=0`) + `tests/helpers/credentials.ts` (skip-gate + tmpdir helpers) — _tsup/biome configs pending_
- [x] `src/cli/registry.ts` — group/command registration API _(deferred — group modules register onto commander directly; extract a registry abstraction only if a third group needs it)_
- [x] `src/config/paths.ts` — `resolveDataDir(flag, env, platform)` + `configDir()` (lazy; `DITTO_CONFIG_DIR` test override)
- [x] `src/cli/groups/dql/` with `doctor` subcommand: platform/arch vs. SDK matrix, Node version, data-dir writability, token presence + expiry
- [x] Stub groups `skills` (add/update/list → "not yet implemented" exit 2) and `system` (`version` prints version/channel=dev/platform; `update` stub) — _partial: `ditto version` is commander's `--version`; skills/system groups land at M6/M7_
- [x] `AGENTS.md` — build/test/run conventions; README stub — _AGENTS.md done; README at M8_
- [x] `.github/workflows/ci.yml` — lint, typecheck, unit on macos/ubuntu/windows × Node 22/24; integration+e2e job (macOS, secrets-gated); bundle token-grep guard
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

**Goal:** vendored benchmark suites loadable as generated sample data; catalog queries runnable by name. ✅ DONE

- [x] `datasets/` at repo root, one module per suite — vendored from `getditto/dql-metrics-benchmark` (`benchmarks/{movies,retail,retail-joins,pos}/benchmarks.json` copied verbatim — 49/72/96/44 catalog queries). Collection shapes, setup DDL, generator descriptors in `suite.ts`. **No NDJSON committed.**
- [x] `src/datasets/rng.ts` — mulberry32 seeded RNG + helpers (int, pick, weighted, chance, gauss, poisson, sample, uuid); determinism unit-tested. `src/datasets/util.ts` — benchmark-exact `deterministicUuid` (SHA-256; Seattle store rls_user_id matches catalog literal) + `upsertAnchors` patch-or-append
- [x] Generators: `movies` (synthesized from field pools — corpus not vendored; invariant repair for 1893/2001/"Star"), `retail` (faithful port: 8 stores/9 categories/400 products fixed, Poisson order walk spanning 2022-12→2025-12, anchors for catalog literals incl. `order_20250115_0001`, `john21@example.net`), `retail-joins` (normalized + 32 product_types, 8% inventory holes, anchor customer w/ 3 orders + `order_20221209_0001`), `pos` (7 locations, 47 sale_items w/ modifier groups, orders with money objects/cart modifiers/status logs/split payments; 2 anchor order ids)
- [x] `src/datasets/loader.ts` — batched `INSERT … DOCUMENTS (deserialize_json(:docN))… ON ID CONFLICT DO UPDATE` (500/batch), stderr progress
- [x] Commands: `ditto dql dataset list|show|load|run|reset`; `run` echoes the statement to stderr (stdout stays clean), `--setup` applies preQueries, write categories require `--yes` (postQueries cleanup applied), ambiguity error lists matches, `reset` = EVICT per collection (WHERE true), `list` supports `--format`
- [x] `reset` confirmation via `--yes`

**Commander bug found + fixed (tested):** a command with both a default action and subcommands swallows same-named child options (`-d`, `--format` silently dropped for `dataset run` — initially loaded data into the *default* store instead of `-d` target). Fixed by routing `ditto dql <stmt>` → explicit `dql exec <stmt>` via argv rewrite (`src/cli/default-command.ts`, unit-tested), with a regression test asserting subcommand flags reach the session.

**Tests:** ✅ unit — RNG (8), registry/ambiguity (4), generator invariants per suite incl. determinism + anchors + referential integrity + money invariants (14), dataset command wiring (9), argv rewrite (7); ✅ integration — load movies/retail/retail-joins/pos into real store, catalog literals return rows, JOIN works, reset evicts only that dataset (5); ✅ e2e — list/show/load/run/reset round-trip + error paths (7).
**Exit:** ✅ `ditto dql dataset load retail --docs 1000` then `ditto dql dataset run stores__select__by_location_city --dataset retail` prints the statement and a populated table. Coverage after M3: **90.9% stmts / 86.2% branches / 91.9% funcs / 91.6% lines** — gate holds.

## M4 — Time / Explain / Profile ✅ DONE

- [x] Spike C: real envelope captured to fixture; `database_id` vs `app_id` difference found and handled
- [x] `src/profile/parse.ts` — `~request_profile` detection (wrapped + bare via marker fields: `times`/`queryType`/`requestType`/`featureFlags`/`state`/`resultCount`, deliberately not `text`), tolerant optional fields, `QueryProfile`/`PlanNode` model
- [x] `src/profile/format.ts` — exact Edge Studio rules; `percentOfTotal(ns, total, 0.05)`; `src/profile/hotspots.ts` — subtree exec, hotspot = exec ≥ 50% of plan-total, `keyAttribute` priority (collection/alias/limit/field/table/condition)
- [x] `src/render/profile.ts` — header (query, captured time, profile id), summary strip (Elapsed/Parse/Plan/Results/Type/State), ASCII tree (`└─`, per-node `exec (pct) · N in / M out`, `▲ HOT` marker), legend footer
- [x] `src/render/explain.ts` — operator tree when recognizable (real 5.1 EXPLAIN uses `operator`/`children` — verified), highlighted raw JSON fallback
- [x] `--time` — `performance.now()` footer; merges server-side elapsed/parse/plan when a profile is present
- [x] Execution gating (Edge Studio rules, unit-tested): PROFILE prefix only for bare SELECT; never `PROFILE PROFILE`; no EXPLAIN side-trip on ADVISE; non-SELECT + `--profile` → "only SELECT statements are profilable" note to stderr
- [x] Wired into `dql exec` and `dql dataset run` (`--time`/`--explain`/`--profile`)

**Tests:** ✅ unit — parser vs. real fixture (parse fields, bare-form marker rule, no `text` false-positive, stats/attributes, reserved-key exclusion), formatNs boundaries, percentOfTotal, hotspots, keyAttribute, renderProfile snapshot-ish assertions, renderExplain tree + fallback, runStatement gating matrix (prefix/no-double-prefix/non-SELECT note/ADVISE never side-tripped, --time footer with server times); ✅ integration — live `--profile` envelope parsed with real plan tree, `--explain` side-trip, `--time` server merge; ✅ e2e — `--profile` view + `--time` footer, non-SELECT note. **242/242 green; coverage 92.1/87.1/93.6/92.7 — gate holds.**
**Exit:** ✅ `ditto dql --profile "SELECT …"` renders the full profile view (verified live against the real store).

## M5 — Advise ✅ DONE

- [x] Live probe: ADVISE on SDK 5.1.0 returns `[{ advice: { statement, suggestedIndexes: [{ collection, reason, statement }], outcome? } }]` — CREATE INDEX statements use `default:\`collection\`` qualification
- [x] `src/query/advise.ts` — forgiving extraction (scan rows, merge `advice.suggestedIndexes[]`, drop partials missing `collection`/`statement`)
- [x] `src/render/advise.ts` — "Index advice" card: analyzed statement; per suggestion `collection — reason` + CREATE INDEX; empty state with `outcome` text; `✓ created`/`✗ failed` badges post-apply
- [x] `--advise` / `--apply` / `-y` on `dql exec` (and available on `dataset run` base opts): apply confirms via @inquirer/prompts on TTY (stderr), `-y` skips, non-TTY without `-y` skips with a note; per-statement created/failed
- [x] Gating (unit-tested): `--advise` wins over `--profile`/`--explain` with a one-line note; user-typed `ADVISE …` renders the card directly (no double-wrap); non-SELECT + `--advise` → plain run with note

**Tests:** ✅ unit — extraction (standard/empty-outcome/multi-row-merge/partials/none), renderer (suggestions/empty/badges), runStatement gating (wrap/precedence/non-SELECT/user-typed, apply confirm/decline/-y/failure) (12); ✅ integration — live ADVISE→apply→`system:indexes` round-trip; ✅ e2e — advice card + created badge. **260/260 green; coverage 91.9/87.5/93.7/92.6 — gate holds.**
**Exit:** ✅ `ditto dql --advise "SELECT …"` prints advice; `--apply` creates the index (verified live: `adv_movies_rated_year` visible in `system:indexes`).

## M6 — Skills (`ditto skills`) ✅ DONE

- [x] `src/skills/github.ts` — resolve ref (latest release via `repos/getditto/agent-skills/releases/latest`, fallback `main`); tarball via codeload; `GITHUB_TOKEN`/`DITTO_GITHUB_TOKEN` auth; 401/404 → actionable guidance. Test seam: `DITTO_SKILLS_TARBALL=<local .tar.gz>` bypasses the network (e2e)
- [x] `src/skills/fetch.ts` — tarball → extract `skills/<name>/` via `tar` (regular files/dirs only — symlinks/links/devices dropped; macOS junk filtered); staging cleanup on any failure; missing `SKILL.md` → clean error
- [x] `src/skills/agents.ts` — registry: claude, opencode, codex, gemini (global+project skill dirs), cursor (`.cursor/rules`, project-only), copilot (`.github/instructions/<skill>.instructions.md` single-file, project-only), windsurf (`.windsurf/rules/<skill>.md` single-file, project-only); detection = global dir or project markers
- [x] `src/skills/install.ts` — per-agent failure isolation; atomic swap (stage+rename — no stale files after update); single-file emitters flatten SKILL.md with an HTML-comment marker; `.dql-skill.json` markers; unreadable dirs skip with a warning
- [x] Commands: `add` (`--skill`/`--all`/`--agent`/`--project`/`--force`), `update` (ref-compare skips fetch when current; per-target updated/current/skipped), `list` (global or `--project`; JSON `[]` on stdout when empty — stdout purity)
- [x] Exit codes: all-fail add/update → 2, unknown agents skipped with detail, `--project` must exist, FormatError → 2, fetch failures → 1 with guidance
- [x] `--dry-run` — dropped (spec §9 doesn't require it; scope kept tight)

**Tests:** ✅ unit — registry/detection/target matrix (incl. single-file agents), installer (failure isolation, atomic swap, markers, file emitters, unreadable dirs), github (ref resolution, auth headers, error mapping, seam), fetch (real tarballs incl. junk filter/missing skill/symlink drop), wiring via injected deps (ref-advance, all-fail exit 2, FormatError, no-agents, branch matrix); ✅ e2e — fixture tarball seam: add/list/update round-trip, private-repo guidance, usage errors. **One adversarial round on the new code: 17 findings, all fixed** (per-agent crash isolation, atomic update swaps, --skill/--all honored, stdout purity on empty states, symlink filtering, copilot/windsurf as instruction-file emitters, e2e seam).
**Exit:** ✅ `ditto skills add --project .` installs the dql skill; private-repo path verified live end-to-end.

## M7 — Self-update ✅ DONE

- [x] `src/update/check.ts` — registry `latest` for `@dittolive/cli`; cache `{ checkedAt, latest }` in state.json (atomic store), 24h TTL; failures silent; opt-outs: `CI`, `DITTO_NO_UPDATE_CHECK`, `--no-update-check`, non-TTY, `--quiet`, `--format json`
- [x] `src/update/channel.ts` — channel detection: realpath of argv entry under Homebrew Cellar → `brew`; under npm global prefix/node_modules → `npm`; dev checkout/unknown → manual instructions, never self-elevate
- [x] `src/cli/update-banner.ts` — one-line stderr banner from the cache only (instant, never blocks); stale cache refreshes in background (≤1s cap); never on stdout, never after a failing command
- [x] `ditto version` — version, channel, token expiry, data dir, platform/arch, Node version (`--format json`)
- [x] `ditto update` — `--check` reports only; runs the channel's upgrader (shell form for brew's `update && upgrade`); unknown channel → manual instructions; failures exit 1

**Tests:** ✅ unit — check (cache TTL/stale/corrupt, isNewer matrix incl. prereleases, all opt-outs incl. CI-env control), channel (brew/npm/dev/unknown fixture paths), banner (cache-driven, opt-outs), system wiring (version fields + json, update --check/run/fail/unknown-channel); e2e via the real binary (version fields, update --check 404 graceful).
**Exit:** ✅ banner shows on simulated outdated install; `ditto update` dispatch verified on both channels (unit) + live 404 degradation (pre-publish).

### CI hardening (landed with M7)
- Node 22+ floor everywhere (Node 20 EOL April 2026): engines, matrix now 22/24, doctor check, docs
- Coverage gate holds in both modes (with/without integration secrets): session.ts unit-covered via mocked dynamic SDK import; repl.ts excluded (pty/e2e-verified wiring)
- `.gitattributes` eol=lf — Windows autocrlf lint failure fixed
- Windows: chmod-based tests skip on win32; HOME+USERPROFILE tilde handling
- CI green on main ✅

## M8 — Distribution & release

- [x] `scripts/stamp-token.ts` — reads `DQL_OFFLINE_LICENSE`; salt → key → XOR → 7 chunks + 5 decoys at fixed positions → base64url → `build/token-chunks.ts`; expiry guard: fail < 45 days, warn < 90 days (JWT `exp`, `--expires` override for non-JWT formats) — _done: `src/identity/obfuscate.ts` (pack/unpack, fixed slots), expiry from JWT `exp` or CBOR `expiry` ISO; `--expires` override_
- [x] Release build mode: `RELEASE=true` define; verify dev token env is dead in release bundle (e2e asserts env ignored) — _done: esbuild plugin aliases `token-chunks.stub.js` → `build/token-chunks.ts`; verified manually (env-less + bogus-env runs). e2e release-build coverage deferred to release.yml_
- [ ] `.github/workflows/release.yml` — on `v*` tag: full test matrix → stamp → build → `npm publish --provenance` → GitHub release → formula bump job
- [ ] `scripts/bump-formula.ts` + `getditto/homebrew-tap` `Formula/ditto.rb` template — npm tarball URL + sha256, `depends_on "node"`, test block (`ditto version`); bump opens PR or direct-commits (decide with repo owners)
- [ ] `.github/workflows/token-expiry.yml` — weekly cron; < 90 days → maintainer alert
- [ ] README — install (npm/brew), quickstart, all flags, skills usage, platform matrix, token-expiry explainer
- [ ] `npm pack` dry-run audit (no raw token strings in tarball — CI step greps the bundle for the token and fails on match)

**Tests:** unit — stamp-token round-trip vs. runtime reassembly, expiry guard thresholds, formula rendering; CI — release dry-run on pre-release tag; manual — `brew install` from tap on macOS + Linuxbrew, `npm i -g` on all three OSes, smoke `ditto dql doctor`.
**Exit:** v1.0.0 published to npm + Homebrew; token-expiry grep clean.

---

## M9 — `dittosh server` (portal HTTP API) — branch `portal-support`

**Goal:** full client for the Ditto Server (Big Peer) HTTP RPC API — the API the portal's DQL editor uses. Endpoint inventory from the public docs (`docs.ditto.live/cloud/http-api`, incl. the OpenAPI spec at `/cloud/http-api/api/openapi.json`) and the portal's own client (`cloud-services/portal/core/src/api/rpcClient.ts`).

- [x] Config resolution (`src/server/config.ts`): flags (`--url`/`--api-key`) > shell env (`DITTOSH_SERVER_URL`/`DITTOSH_SERVER_API_KEY`, aliases `DITTO_CLOUD_URL`/`DITTO_API_KEY`) > cwd `.env` (parsed via `util.parseEnv`, never overrides real env). URL normalized (scheme added, trailing slashes stripped). Missing config → exit 3 with portal guidance. `sources` tracked for `server doctor`. `--api-version v4|v5` (default v5) selects the `/store/execute` API version.
- [x] HTTP client (`src/server/client.ts`): global fetch (injectable for tests), `Authorization: Bearer`, `X-DITTO-TXN-ID`, 30s timeout, JSON-or-text error bodies, API-key redaction in error messages (≥8 chars). Error mapping: 401/403 + connection failures → exit 3; other HTTP rejections → exit 1.
- [x] `server execute` (alias `exec`) — POST `/api/v{4,5}/store/execute`: positional/`-e`/`-f`/stdin batch (one call per statement, `--continue-on-error`), `-p`/`--args` binding, `--txn-id`, all output formats + `-o` + pager + `--max-rows` + `--time` (same render pipeline as local `dql`). DQL errors arrive as `error.description` in a 200/400 body → exit 1. Batch dot-command stripping is local-REPL-only, not applied here.
- [x] `server remote-execute` — POST `/api/v5/sync/remote_execute`; client-side SYNC CONTEXT check (exit 2); per-peer JSON envelope out.
- [x] ~~Legacy store API~~ — **pulled post-review**: find/findbyid/count/write are the legacy pre-DQL API; `server execute` covers all of it with full DQL. (Verified live that legacy `:param` placeholders are rejected by the current deployment despite the OpenAPI text — another reason not to ship them.)
- [x] `server attachment upload|get` — multipart POST / byte GET; get refuses binary on a TTY without `-o`, pipes raw bytes otherwise.
- [x] `server roles list|create|delete` + `server users list|set-roles|delete` — RBAC endpoints the portal uses (undocumented publicly); both GET /roles wire shapes (bucketed + cursor-paged) normalized. Destructive deletes confirm (`-y` / TTY prompt / exit 2 piped).
- [x] `server webhook-secrets list|create|rotate|delete` — auth webhook HMAC secrets; delete/rotate look up the full secret object from `--secret` (server requires it).
- [x] `server doctor` — config (with sources) → connection → auth probe (`SELECT * FROM system:collections LIMIT 1`; "SELECT 1" is invalid DQL — FROM required — observed live). 401/403 → auth ✗; 400 → key accepted (auth happens before query parsing); unreachable → connection ✗. Exit 0/3.
- [x] Rich `--help` on every command: request body shapes, wire formats, and examples (the APIs are mostly undocumented — help text is the documentation).
- [x] Tests: `tests/unit/server-config.test.ts`, `server-client.test.ts`, `server-run.test.ts`, `server-doctor.test.ts`, `cli-server.test.ts`, `cli-server-branches.test.ts`; e2e `tests/e2e/server.test.ts` (node:http mock server, real subprocess; `extendEnv: false` — execa v10 renamed `extend`).
- [x] `docs/testing-server.md` — manual checklist against the retail dataset in the portal.
- [x] Verified against the real portal (retail app): SELECT/params/aggregates, EXPLAIN-as-statement, INSERT→SELECT→UPDATE→DELETE round-trip, doctor with good + bad keys.

**Findings (verified live, documented in `--help` and `docs/testing-server.md`):**
- Big Peer requires `FROM` in SELECT (`SELECT 1` → 400). Doctor probe uses `system:collections`.
- execa v10: env isolation option is `extendEnv: false` (was `extend` in v9) — e2e spawns rely on it to stay hermetic now that the repo `.env` holds real portal credentials.

**Not covered (deliberate):** JWT `http_login` exchange (API key is the CLI's model), CDC/Kafka streams (not request/response), no server-side REPL (one-shot + batch only).

**Adversarial review: 5 rounds, 2 independent reviewers each, CONVERGED (both agreed).** Rounds 1–4 (~25 issues, each with regression tests): batch mode flattened auth/connection failures to exit 1 and retried dead servers (now exit 3 + stop); list commands validated `--format`/`--max-rows` after the network call (now exit 2, zero requests); `remote-execute --args -` hung on a TTY; URLs with userinfo/query/fragment were accepted (credential echo + misrouted paths — now rejected); mid-body timeouts escaped error mapping as raw `TimeoutError`; `roles list` silently truncated the cursor-paged wire shape (now `--cursor` + continuation note); 200-with-error bodies now fail closed (`assertNoErrorBody` everywhere except `execute`, whose errors need statement context); `stripEq` restricted to dual short/long options; `hasError(null)` per-peer crash. Reviewers also caught a false "lint clean" claim (empty `tail` output read as success) — gates are now verified by exit code.

**Round 5 (fresh reviewers, agree-before-fixing rule — fixes only landed where both agreed after cross-verification):** fail-closed shape validation on ALL 2xx responses (execute/remote-execute require DQL hallmark keys; roles/users require their envelope keys — portal parity; webhook list keeps the portal's deliberate `[]` fallbacks incl. 404→`[]`); non-loopback `http://` rejected (the cloud's 308 made hop 1 cleartext-with-key, hop 2 anonymous → misleading 401); `--timeout` flag (default 120s) + `PortalTimeoutError` with honest "may still be running" message, exit 1 (the portal bounds only login/RBAC writes; DQL is unbounded there); unpasteable `roles create --help` example (single quotes can't nest) fixed to `\"…\"`; `.env` UTF-8 BOM strip; per-key .env hints; batch `stdoutBroken()` check; users-404 "unsupported endpoint" hint; `--permissions` blanket-string whitelist; e2e coverage gaps closed per the house convention (doctor, users, webhook-secrets, roles write, attachment upload, remote-execute happy path); docs/testing-server.md corrected (webhook §7 needs a pre-existing provider — verified live; attachment len 16; portable exit-code capture; `cut -d= -f2-`; ps/history warning for `--api-key`). README gained the full `dittosh server` feature section.

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
| 7 | **SDK 5.1.0: `joins__left__products_inventory_stock_value` hangs** (nlJoin over intersectScan when `inv_store_flat` + `inv_product_flat` indexes exist; `coalesce(i.stock_level,0)` projection) — found by adversarial review R12 | none (CLI marks it known-issue in `dataset show`/`run`) | SDK team | **open — report upstream** |
| 8 | **SDK 5.1.0: `NO_COLOR` env var panics the native tracing layer** (abort, exit 134) — CLI scrubs `NO_COLOR` before the SDK loads (`src/ditto/sanitize-env.ts`) | none (CLI mitigates) | SDK team | **open — report upstream** |

## Known issues

- `retail-joins` catalog query `joins__left__products_inventory_stock_value` hangs SDK 5.1.0 when the `inv_store_flat` index exists (see dependency 7). The CLI marks it as a known issue in `dataset show` and warns on `dataset run`. Workaround: run without `--setup`, or append `LIMIT`.
- CSV output does not escape formula-injection-leading characters (`=`, `+`, `@`) — accepted for a dev tool; don't feed CSV into Excel unsanitized.
- A killed `dataset run` of a write-category entry (Ctrl-C between fixture INSERT and cleanup EVICT) leaves the fixture doc; the vendored catalog's fixture INSERTs lack `ON ID CONFLICT`, so the next run's INSERT fails once with a duplicate-key error, then self-heals (cleanup EVICTs it). Catalogs are vendored verbatim — accepted.
- SDK 5.1.0 native fragility family (reported upstream): `NO_COLOR` abort (CLI mitigates by scrubbing) and a dead stderr pipe (`2> >(exec false)`) aborting at SDK init (exit 134) — not mitigated; the init-time 7-line burst usually fits pipe buffers, so `2>&1 | head` is unaffected.
- SDK 5.1.0: `SELECT * FROM system:collections` returns rows only on the FIRST `store.execute` of a session (subsequent calls return 0 items; a fresh session on the same dir works) — reproduced against the raw SDK, reported upstream. Affects `dql collections` twice in one REPL/batch. Not CLI-fixable.
- `dataset run`'s fixture INSERTs are vendored verbatim; killing mid-run can leave one cryptic duplicate-key failure on the next run, then self-heals.

## Spike findings log

- **Spike A (v5.1 init + offline token):** ✅ PASS (2026-08-29, `scripts/spike-a.mjs`). `sdk.init()` → `new DittoConfig(appId, { mode: "smallPeersOnly" }, storeDir)` → `Ditto.open(config)` → `setOfflineOnlyLicenseToken(token)` all work on `@dittolive/ditto@5.1.0` with the dev offline playground token. INSERT with `COLLECTION … (field MAP/COUNTER)` + `ON ID CONFLICT DO UPDATE` ✅, parameterized SELECT ✅, `EXPLAIN` returns first item keyed `plan` ✅, `PROFILE` appends trailing item keyed `~request_profile` ✅, `close()` clean ✅. **Gotcha:** SDK emits verbose INFO/WARN logs on open — the CLI must set the SDK log level to error-only (investigate `DittoLogger`/env) so output stays pipeable.
- **Spike B (lock error shape):** ✅ PASS (2026-08-29). Two processes on one data dir: second `Ditto.open` throws with message containing "File already locked" — mapped to exit code 4 with an actionable message ("The data directory is in use by another ditto process: <path> …").
- **Spike C (real profile envelope vs. fixture):** ✅ PASS (2026-08-29, `scripts/spike-c.mjs` → `tests/unit/fixtures/profile-envelope.json`). Confirmed envelope keys on SDK 5.1.0: `_id, database_id, directives, featureFlags, plan, queryType, requestType, resultCount, state, text, times{elapsed,parse,plan,start}`. **Differs from Edge Studio's assumption in one field: `database_id` (not `app_id`)** — parser accepts both. Plan tree uses `#operator`/`#stats`/`children` as expected.
- **Known cosmetic issue:** the native tracing bootstrap writes ~7 WARN/INFO lines to stderr at `sdk.init()` via fd-level writes — not suppressible from JS (`Logger.enabled=false` kills all open-time logs; `RUST_LOG`/`DITTO_LOG` ignored). stdout stays pure, piping unaffected. Possible SDK-team follow-up.
