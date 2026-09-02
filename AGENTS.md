# AGENTS.md — `dittosh` CLI (`@dittolive/cli`)

## What this is

The Ditto CLI: an npm/Homebrew-installable TypeScript CLI (binary `dittosh` — renamed from `ditto` to avoid clashing with the macOS/Linux `ditto` tool) whose first command group, `dittosh dql`, runs DQL statements against a local, offline-only Ditto store. Canonical spec: `plans/SDKS-4855-dql-cli-tool.md`. Working checklist: `plans/SDKS-4855-implementation-plan.md` (tick boxes as work lands).

## Hard rules (from the spec — do not regress)

- **Offline-only.** Never call `startSync()`. No `--sync`, no user-supplied credentials (`--app-id`/`--license`, config commands). Every install shares one app ID — sync would leak data between users on a LAN.
- **Dev credentials:** repo-root `.env` (`DATABASE_ID`, `OFFLINE_TOKEN`, `EXPIRE_ON`; aliases `DQL_OFFLINE_LICENSE`/`DITTO_APP_ID`), gitignored, honored only in dev builds. Release builds (`RELEASE=true npm run build`) ignore env credentials and use the stamped, obfuscated embedded token (`scripts/stamp-token.ts`, M8).
- **stdout is sacred.** Query results are the only thing on stdout (JSON when piped). Progress, warnings, banners, SDK logs → stderr. Never break this (jq composability is a feature).
- One DQL statement per `store.execute` call; no trailing `;`.
- Exit codes: `0` ok · `1` query/DQL error · `2` usage · `3` platform/token · `4` data-dir lock.
- Colors off when `NO_COLOR`, `CI`, `--no-color`, or non-TTY.

## Layout

- `src/cli/` — commander entry (`index.ts`), injected version (`version.ts`, tsup `define`), `groups/` per command group (`dql`, later `skills`, `system`)
- `src/config/` — data-dir resolution (`--data-dir` > `DITTOSH_DATA_DIR` > OS default), config dir (`DITTOSH_CONFIG_DIR` > OS default; env-paths caches homedir at module load, so tests must use this override, not `$HOME`), persisted state (one-time warnings, update cache)
- `src/identity/` — token loading (dev env / release reassembly), expiry
- `src/ditto/session.ts` — the only SDK touchpoint: init/open/close, log taming, lock mapping
- `src/query/` — statement classifier, splitter, param binding, result extraction, row cap
- `src/render/` — table/JSON/CSV, `-o/--out`, (M4: explain/profile/advise renderers)
- `datasets/` — vendored benchmark suite definitions (movies, retail, retail-joins, pos); **no generated data ever committed**
- `scripts/` — `spike-a.mjs` (SDK verification), `stamp-token.ts` (M8)
- `tests/unit|integration|e2e` + `tests/setup/env.ts` (loads `.env`) + `tests/helpers/`

## Commands

```bash
npm run dev -- <args>      # run the CLI from source (tsx, loads .env)
node --env-file=.env dist/cli.js <args>   # run the built bundle with dev credentials
npm run build              # tsup dev build → dist/cli.js
npm run stamp:token        # stamp build/token-chunks.ts from .env (obfuscated; gitignored)
RELEASE=true npm run build # release build (env credentials disabled; needs stamp:token first)
npm test                   # all vitest projects
npm run test:unit|test:int|test:e2e
npm run typecheck          # tsc --noEmit
npm run lint               # biome check
npm run spike:a            # SDK init/token/DQL smoke script
```

## Testing conventions

- **unit** (`tests/unit`): no SDK. Fast; snapshot-friendly (`FORCE_COLOR=0` in setup).
- **integration** (`tests/integration`): real offline Ditto in a fresh tmpdir per file. Skip-gated on dev credentials via `tests/helpers/credentials.ts` (`hasDevCredentials`, `NO_CREDENTIALS`). `fileParallelism: false` — the native module holds process-wide state.
- **e2e** (`tests/e2e`): execa spawning `node --import tsx --env-file=.env src/cli/index.ts`. Assert exit codes and both stdout/stderr separately. Each test uses its own tmp `-d` data dir.
- New user-facing command ⇒ e2e coverage. New logic ⇒ unit coverage. New SDK behavior ⇒ integration coverage.
- **Coverage is a hard gate: ≥ 85%** statements/branches/functions/lines, enforced by `npm run coverage` (unit + integration projects, thresholds in `vitest.config.ts`) and in CI. `src/cli/index.ts` (process entry) is excluded deliberately — e2e covers it; v8 can't see subprocesses. Keep CLI glue thin: logic lives in injectable, unit-testable modules (see `doctor.ts`, `batch.ts`, `repl-core.ts`, `run.ts`).

## Known platform facts

- SDK `@dittolive/ditto@5.1.0` native matrix: macOS arm64, Linux x64/arm64, Windows x64 (no darwin-x64).
- `DittoConfig(appId, { mode: "smallPeersOnly" }, dir)` + `Ditto.open` + `setOfflineOnlyLicenseToken` — verified (Spike A). EXPLAIN → first item `plan`; PROFILE → trailing `~request_profile` item.
- The native tracing bootstrap writes ~7 WARN/INFO lines to **stderr** at `sdk.init()` (fd-level, not suppressible from JS). Cosmetic only; stdout is clean.
- Two processes on one data dir → "File already locked" → mapped to `LockError` (exit 4).
