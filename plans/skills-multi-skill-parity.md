# Plan: `dittosh skills` — multi-skill support & Android-CLI parity

> **Status (2026-11-03):** landed in branch `skills/release-assets`:
> asset-first fetch + codeload fallback, `listReleases`, `listSkills`/
> `extractSkills` (dual-layout), positional `[name]`, real `--all`, `--ref`
> pinning, `skills versions`, default `write-dql`, `dql` alias + update-time
> migration. Upstream release workflow: getditto/agent-skills PR #37.
> **Remaining:** `skills export` (ZIPs for Claude Desktop), Antigravity agent
> target (both deferred to a follow-up PR).

Goal: `dittosh skills` installs the Swift AI agent skill files (and the other Ditto
skills) with the same option surface as the Android CLI (`android skills add|update`)
does for `android/skills` — and an install experience at least as good as what
Couchbase offers for its `Couchbase-Ecosystem/agent-skills` repo (see benchmark below).

## Status review (as of 2026-11-02)

**Already shipped (M6):** `dittosh skills add|list|update` exists and is tested.

- Fetch layer `src/skills/github.ts`: `getditto/agent-skills`, latest release tag →
  fallback `main`, `GITHUB_TOKEN`/`DITTOSH_GITHUB_TOKEN` auth + private-repo guidance,
  `DITTOSH_SKILLS_TARBALL` test seam.
- Extract `src/skills/fetch.ts`: pulls `skills/<name>/` out of the codeload tarball,
  files/dirs only (no symlinks), requires `SKILL.md`.
- Install `src/skills/install.ts`: atomic stage+rename, `.dql-skill.json` markers
  `{skill, ref, installedAt, channel}`, per-agent failure isolation, `findInstalled`.
- Agents `src/skills/agents.ts`: claude, opencode, codex, gemini, cursor, copilot, windsurf.
- CLI `src/cli/groups/skills/index.ts`: `--skill` (default `dql`), `--all` (**stub**),
  `--agent`, `--project`, `--force`, `--format`; injected `SkillsDeps` for tests.

**Upstream repo facts (verified via `gh api`):**

- `skills/` currently contains **5 skills**: `data-modeling`, `ditto-mesh-networking`,
  `swift-sdk`, `sync-subscriptions`, `write-dql`.
- **Assume two open PRs land** (per user direction):
  - PR #31 (Kotlin, `da-280-kotlin-sdk-skill`) adds `skills/kotlin-sdk` + `skills/data-streams`.
  - PR #36 (JavaScript, `da-279/javascript-platform-skills`) adds `skills/js-sdk`,
    `js-expo`, `js-node`, `js-react-native`, `js-web`, `native-app-config`.
  - → **12 skills** total once merged. All are top-level `skills/<name>/` dirs with
    `SKILL.md`, so the generic `listSkills`/`extractSkills` enumeration handles them
    with **zero special-casing** — this is the strongest argument for not hardcoding
    a skill list anywhere in the CLI.
  - Several carry large `assets/` subdirs (Expo starter, gradle wrappers, plist
    templates) and nested `references/` — `extractSkills` must stay a full recursive
    copy (it already is) and the fetch filter must not assume a flat layout.
- **There is no `skills/dql/`** — the DQL skill was renamed to `write-dql` when the
  repo was restructured into per-SDK skills (that's why "DQL doesn't exist on its own";
  it lives on as `skills/write-dql/SKILL.md`). Consequence: today's default
  `--skill dql` fails extraction for every no-arg `dittosh skills add`. This is a live bug.
- No releases or tags yet → `resolveRef()` returns `main`. **This changes with this
  plan (see §5 below):** we add a release workflow upstream, and the CLI switches to
  downloading a slim, versioned release asset.
- **Precedent (verified):** `android/skills` ships 30 releases; each attaches a
  pre-built `android-skills.zip` (1.37 MB, ~240k downloads on v1.0.19) that the
  Android CLI downloads instead of the repo tarball. Versioned, pre-built,
  content-only release artifacts are the established pattern (same idea as npm's
  `files` whitelist, Homebrew bottles, GH CLI extensions). The full-repo codeload
  tarball is the dev fallback, not the production path.

**Parity gaps vs `android skills`:**

| Android CLI | dittosh today | Action |
|---|---|---|
| `android skills add r8-analyzer` (positional) | `--skill <name>` flag only | add positional `[name]` |
| `android skills add --all` installs all skills | `--all` is a stub (installs one) | enumerate skills from tarball |
| `android skills update --all` / `update <name>` | `--skill` only, no `--all` | positional + `--all` on update |
| Default skill (`android-cli`) | default `dql` — broken upstream | **default becomes `write-dql`** |
| No agents detected → installs to `~/.gemini/antigravity/skills` | exit 2 with guidance | **keep current behavior** (decided) |

## Competitive benchmark: Couchbase `agent-skills`

Verified via `gh api` (repo is public, no releases — same as ours):

- **Layout:** 4 server-data skills at top-level `skills/` (`couchbase-mcp-setup`,
  `couchbase-natural-language-querying`, `couchbase-query-optimizer`,
  `couchbase-data-modeling`) + 6 mobile skills nested at
  `plugins/couchbase-mobile/skills/` (incl. `couchbase-lite-ios-app`, their Swift skill).
  Our repo keeps all 5 skills at top-level `skills/`, so top-level discovery suffices
  for us (their nesting only matters if we ever add a `--repo` flag — decided against).
- **Install UX:** the repo doubles as a plugin marketplace (`.claude-plugin`,
  `.codex-plugin`, `.cursor-plugin`, `gemini-extension.json` bundling an MCP server
  config) and documents per-harness installs: Claude Code, **Claude Desktop** (manual
  per-skill ZIP upload), Codex CLI/Desktop, **Antigravity**, Gemini CLI, Copilot CLI,
  Cursor. Our repo already ships the same marketplace manifests, so marketplace
  installs are a docs task — the CLI gaps are the two harnesses with no marketplace.
- **Quality bar for us:** harness coverage parity. We cover claude, opencode, codex,
  gemini, cursor, copilot, windsurf. **Gaps: Antigravity and Claude Desktop.**

## Decisions (confirmed with user)

1. **Default skill is `write-dql`.** No-arg `dittosh skills add` installs the DQL skill
   under its upstream name (mirroring Android CLI's `android-cli` default). The CLI's
   original `dql` default was renamed upstream; defaulting straight to `write-dql`
   keeps no-arg installs working and matches the CLI's DQL focus.
2. **Keep the no-agents-detected behavior**: exit 2 with "pass --agent explicitly".
   No silent fallback dir.
3. **Back-compat alias `dql` → `write-dql`.** Existing installs carry markers with
   `skill: "dql"`. `add --skill dql` / `add dql` resolves to `write-dql` (with a stderr
   note), and `update` matches old `dql` markers and re-installs them as `write-dql`.
   The marker is rewritten to the upstream name on update.
4. **`--skill` flag stays** as a deprecated alias of the positional (hidden in help),
   so existing scripts don't break. Conflict (positional ≠ `--skill`) → exit 2.
5. **Ditto repo only.** No `--repo` flag — the CLI installs from
   `getditto/agent-skills` exclusively. The Couchbase repo is a UX quality benchmark,
   not a fetch source.
6. **Close two Couchbase-parity harness gaps:** add an **Antigravity** agent target
   and a **`skills export`** command producing per-skill ZIPs for Claude Desktop's
   manual upload. **No MCP config wiring** (their `gemini-extension.json` bundles an
   MCP server; ours stays out of scope — follow-up if wanted).
7. **Slim versioned release assets replace the full-repo tarball** (user decision
   2026-11-03). The repo's `tests/` dir alone is 2.9 MB on the JS PR branch (66% of
   the repo) and will keep growing; installs should never pay for it. A GitHub
   Action in `getditto/agent-skills` builds a skills-only tarball per release; the
   CLI prefers the release asset and falls back to the codeload tarball for `main`
   (dev) and pre-release-history tags.

## Implementation

### 1. `src/skills/fetch.ts` — enumerate & multi-extract
- `listSkills(tarball: Buffer): Promise<string[]>` — `tar.t` pass collecting
  `<root>/skills/<name>/SKILL.md` entries; returns sorted names. Used by `--all` and
  by validation error messages ("unknown skill 'foo' — available: …").
- **No hardcoded skill names anywhere.** The upstream set is 5 today, 12–13 once the
  Kotlin/JS PRs land, and will keep growing. Every command (`add`, `update`,
  `export`, and all error messages) must derive the skill list from the tarball at
  runtime. The only name constants in the CLI are `DEFAULT_SKILL = "write-dql"` and
  the `dql → write-dql` alias.
- `extractSkills(tarball, names): Promise<Map<string, string>>` — one staging dir, one
  `tar.x` pass with a name-set filter, returning skill name → staged dir. **Must accept
  both archive layouts**: codeload tarballs carry a `<owner>-<repo>-<sha>/` root prefix
  (current `strip: 3`); release assets have `skills/` at the archive root (strip 2).
  Detect by scanning entry paths (`(^|/)skills/<name>/` match) rather than assuming a
  fixed strip depth. Keeps the symlink/junk filtering and per-skill `SKILL.md`
  sanity check. Must handle arbitrary nesting (`references/`, `assets/` with binary
  files like gradle-wrapper.jar — the JS/Kotlin skills ship these). `extractSkill`
  becomes a thin wrapper (or is replaced at call sites).
- Reuse the `ditto-skill-` mkdtemp staging pattern; `cleanupStaging` already removes
  the parent, so multi-extract stages each skill under one parent temp dir.

### 2. `src/skills/github.ts` — release-asset-first fetch

- `fetchTarball(ref)` becomes **asset-first**:
  1. `GET /repos/getditto/agent-skills/releases/tags/<ref>` → look for the
     `ditto-skills.tar.gz` asset → download via the asset API URL with
     `Accept: application/octet-stream` + existing token headers (required — the repo
     is private; `browser_download_url` alone won't authenticate).
  2. No release or no asset (e.g. ref is `main` or a pre-workflow tag) → fall back to
     today's codeload tarball. A stderr `note()` says which path was taken.
- `resolveRef()` is unchanged — it already prefers `releases/latest`, so the first
  upstream release automatically gives users versioned refs and meaningful
  `.dql-skill.json` markers + `update` diffs.
- Private-repo note: asset downloads on private repos must use the API assets
  endpoint, not the browser URL — covered by the existing `GITHUB_TOKEN` guidance.
- The `DITTOSH_SKILLS_TARBALL` test seam is untouched.

### 3. `src/cli/groups/skills/index.ts` — command surface

**`add [name]`**

- Positional `[name]`; `--skill` kept hidden/deprecated; `--all` real.
- Resolution order: positional → `--skill` → default `write-dql`. Alias-map through
  `ALIASES = { dql: "write-dql" }` (stderr note when aliased).
- Unknown name → fetch once, `listSkills`, exit 2 with the available list.
- `--all`: resolve ref → fetch tarball **once** → `listSkills` → `extractSkills(all)` →
  install each per selected agent → one `renderRows` table (skill × agent rows).
- Single-skill path: same one-fetch flow, extract just that skill.
- Everything else (agent selection, `--project`, `--force`, formats, per-agent
  failure isolation, all-fail → exit 2) unchanged.

**`update [name]` / `update --all`**

- Positional `[name]`, `--skill` deprecated alias, `--all` new.
- `update --all`: scan installed markers across agents, group by skill (applying the
  `dql`→`write-dql` alias when matching upstream names), resolve ref once, skip the
  download when every install is current, fetch once, `extractSkills(staleNames)`,
  reinstall stale targets with `force: true`.
- Old `dql` markers: treat as `write-dql`; on update the install path is rewritten to
  the upstream name (stale `dql` dir removed by the atomic swap).
- No name and no `--all` → updates `write-dql` (the default skill), same as `add`.

**`list`** — unchanged. (Nice-to-have, out of scope: `list --available` to show
upstream skills; Android CLI has no equivalent.)

**`export <name>` (new — Claude Desktop parity)**

- `dittosh skills export <name> [-o <file.zip>] [--all]` — resolves + fetches exactly
  like `add`, extracts the skill, and writes a ZIP whose root is the skill folder
  (what Claude Desktop's *Customize → Skills → Upload a Skill* expects, matching
  Couchbase's documented `zip -r <name>.zip skills/<name>` flow).
- Default output: `<cwd>/<name>.zip`; `-o` path or `-` for stdout (binary to stdout
  only when piped — TTY stdout stays human-safe per the stdout-is-sacred rule).
- `--all` writes one ZIP per skill into `-o <dir>/` (dir required with `--all`).
- New dependency: **`yazl`** (pure-JS ZIP writer, no native code — keeps the tsup
  `noExternal` bundle strategy; add to `noExternal` list). Uses the same streaming
  temp staging as extract; staged dir cleaned up via `cleanupStaging`.
- Logic lives in `src/skills/export.ts` (injectable: `zipDir(dir, outPath)`), CLI glue
  stays thin.

### 4. `src/skills/agents.ts` — Antigravity target

- Add `antigravity` to the registry: global dir `~/.gemini/antigravity/skills/<name>`,
  project dir `.agents/skills/<name>` (verify against Antigravity docs before landing;
  these are the paths Android's skills README documents for its Antigravity fallback).
- Directory-based skill (like claude/gemini), not a single-file emitter — marker file
  `.dql-skill.json` works as-is.
- `detectAgents` picks it up when `~/.gemini/antigravity` exists.

### 5. Upstream: release workflow in `getditto/agent-skills` (new repo work)

A new `.github/workflows/release.yml` in the **agent-skills repo** (not this one):

- **Trigger:** push of a `v*` tag (manual tagging to start; can add
  `workflow_dispatch` + auto-versioning later).
- **Build the slim artifact:**
  - `tar -czf ditto-skills.tar.gz skills/ LICENSE.md` — **only** what agents and the
    CLI consume. Explicitly excludes `tests/`, `docs/`, `.github/`, `plugins/`
    packaging metadata, scripts.
  - Generate `skills-manifest.json` (array of `{name, path, description}` — name/path
    from the dir listing, description parsed from each `SKILL.md` frontmatter) and
    attach it as a second asset. Cheap now; enables a future `skills list --available`
    without downloading anything.
  - Optional hardening: run the repo's existing `scripts/validate-sdk-skills.py`
    before packaging so a release can never ship a broken skill.
- **Publish:** `gh release create <tag> ditto-skills.tar.gz skills-manifest.json
  --generate-notes` (or `softprops/action-gh-release`).
- **Expected size:** ~200–300 KB gz vs. 1.1 MB repo tarball today (and ~2–3 MB once
  the Kotlin/JS test suites land) — and it stays flat as tests grow.
- **Cut `v1.0.0`** (or `v0.1.0`) once the Kotlin (#31) and JS (#36) PRs merge, so the
  first release covers all 12–13 skills.
- **Ordering:** CLI and workflow can land in either order — the CLI's codeload
  fallback keeps everything working until the first release exists.

### 6. Docs & housekeeping

- `AGENTS.md`: fix stale "later `skills`, `system`" line; document new options.
- `plans/SDKS-4855-implementation-plan.md`: tick/note the M6 amendment; fix the stale
  "Status summary" header and `DITTO_*` env names while in there.
- `docs/testing-skills.md`: add the new manual checklist rows (below).
- Spec `plans/SDKS-4855-dql-cli-tool.md` §9: append an amendment noting the multi-skill
  repo layout, positional names, `--all`, and the default change `dql` → `write-dql`.

## Test plan

Coverage gate stays ≥85% (unit + integration). All new logic lives in injectable
modules; CLI glue stays thin.

### Unit — `tests/unit/skills-fetch.test.ts` (extend)

- `listSkills` enumerates `skills/*/SKILL.md` from a fixture tarball; ignores dirs
  without `SKILL.md`, `.DS_Store`/`._*` junk, and non-`skills/` paths.
- `listSkills`/`extractSkills` work against **both archive layouts**: codeload-style
  (`<root>/skills/<name>/…`) and release-asset-style (`skills/<name>/…` at root).
- `extractSkills` with several names returns one staged dir per name, each with its
  files; missing `SKILL.md` for a requested name → `SkillsFetchError`; symlink entries
  dropped.

### Unit — `tests/unit/skills-github.test.ts` (extend; injected `fetchFn`)

- Release with `ditto-skills.tar.gz` asset → asset API URL fetched with
  `Accept: application/octet-stream` + auth header; bytes returned.
- Release exists but no asset → falls back to codeload.
- No release for ref (404) → falls back to codeload.
- Asset download 401/403 → `SkillsFetchError` with the private-repo guidance.

### Unit — `tests/unit/cli-skills.test.ts` (extend; injected `SkillsDeps`)

Deps fakes serve a multi-skill tarball (fixture mirrors the post-PR upstream:
`write-dql`, `swift-sdk`, `kotlin-sdk`, `js-sdk`, `js-expo`, `js-node`,
`js-react-native`, `js-web`, `native-app-config`, `data-modeling`, `data-streams`,
`ditto-mesh-networking`, `sync-subscriptions` — 13 dirs incl. one *without* a
`SKILL.md` to prove it's excluded) via the existing `tar.c` fixture builder and
`home` override. Assert stdout/stderr separately and `process.exitCode`.

`add`:

- `add swift-sdk` (positional) installs to detected agent dirs; table row shows
  `swift-sdk` + resolved ref.
- `add` with no name/`--all` installs `write-dql` (the default); row shows `write-dql`.
- `add --skill swift-sdk` still works (deprecated flag).
- `add foo` (unknown) → exit 2, stderr lists available skills from the tarball.
- `add swift-sdk --skill write-dql` (conflict) → exit 2.
- `add --all` installs every skill in the fixture for every detected agent; one
  `resolveRef`/`fetchTarball` call (assert fake call counts — single fetch).
- `add dql` → installs `write-dql`, stderr note about the rename.
- `--all` with a per-agent failure → partial rows, exit 0; all agents fail → exit 2.

`update`:

- `update --all` refreshes stale installs across multiple skills and agents; current
  installs skipped (no fetch when refs match — assert fetch fake not called).
- Old marker `skill: "dql"` is matched, updated, and re-marked as `write-dql`.
- `update` with nothing installed → `[]` on stdout in JSON mode, note on stderr.
- `update` with no name/`--all` → updates the default `write-dql` installs only.

### Unit — `tests/unit/skills-agents.test.ts` (extend)

- `antigravity` spec: correct global dir under a fake `home`, project dir resolution,
  included in `detectAgents` only when the global root exists.

### Unit — `tests/unit/skills-export.test.ts` (new)

- `zipDir` produces a valid ZIP (assert with `yauzl` dev-dependency: entry list,
  file contents round-trip, no symlinks/`._*` junk).
- CLI: `export write-dql -o out.zip` writes the file and prints the path on stdout;
  `export --all` without `-o <dir>` → exit 2; unknown skill → exit 2 with the
  available list; `export` honors the alias (`export dql` → `write-dql.zip`).

### E2E — `tests/e2e/skills.test.ts` (extend)

Build a multi-skill fixture tarball in `beforeAll` (mimic the post-PR upstream layout:
`<root>/skills/{write-dql,swift-sdk,kotlin-sdk,js-sdk,js-expo,js-node,js-react-native,js-web,native-app-config,data-modeling,data-streams,ditto-mesh-networking,sync-subscriptions}/SKILL.md`
+ one nested `references/x.md` and one `assets/` file each — kotlin-sdk gets a nested
`assets/gradle/wrapper/gradle-wrapper.jar` binary to prove binary files survive
extraction and ZIP export) and point `DITTOSH_SKILLS_TARBALL` at it; per-test tmp
`HOME`/`-d` data dirs as today.

- `skills add kotlin-sdk --project <tmp>` and `skills add js-sdk --project <tmp>` →
  exit 0, skill dirs with nested `references/` intact.
- `skills add swift-sdk --project <tmp>` → exit 0, `<tmp>/.claude/skills/swift-sdk/SKILL.md`
  exists (and other agent project dirs per registry).
- `skills add --all --agent claude` → all 13 skill dirs exist (incl. every JS
  variant); stdout table lists 13 rows.
- `skills add` (no args) → exit 0, installs `write-dql` (default); stdout row shows `write-dql`.
- `skills add nope` → exit 2 with available-skills list (mentions `kotlin-sdk`, `js-sdk`).
- `skills update --all` after `add --all` → "already on fixture" path, exit 0, no changes.
- `skills list --format json` after `--all` → 13+ rows, valid JSON (jq-composable stdout).
- `add dql` alias → installs `write-dql`; `list` shows `write-dql`.
- `skills add swift-sdk --agent antigravity` with a fake `~/.gemini/antigravity` →
  exit 0, `~/.gemini/antigravity/skills/swift-sdk/SKILL.md` exists.
- `skills export kotlin-sdk -o <tmp>/kotlin-sdk.zip` → exit 0; the jar binary
  round-trips byte-identical (yauzl read + compare).
- `skills export swift-sdk -o <tmp>/swift-sdk.zip` → exit 0; `unzip -l` (or yauzl)
  shows `SKILL.md` at the zip root; stdout prints the path, stderr the progress notes.
- `skills export --all -o <tmp>/zips/` → one `<name>.zip` per fixture skill (13 files).
- Piped stdout stays pure JSON with `--format json` (existing invariant, re-assert for
  the `--all` multi-row path).

### Coverage

- New branches in `fetch.ts` and `groups/skills/index.ts` are all exercised by the
  unit matrix above; run `npm run coverage` and keep ≥85% across the board.

## Out of scope / follow-ups

- Plugin-marketplace installs (`/plugin marketplace add getditto/agent-skills`) —
  the upstream repo already ships `.claude-plugin`/`.codex-plugin`/`.cursor-plugin`
  manifests; documenting that path (as Couchbase's README does, harness by harness)
  is a docs task, not CLI work.
- `skills list --available` backed by the release's `skills-manifest.json` asset.
- MCP config wiring (merging `.mcp.json`/`gemini-extension.json` MCP server entries
  into agent configs on install) — Couchbase bundles this in their Gemini extension;
  revisit if Ditto ships an MCP server users should get automatically.
- Generic `--repo <owner/name>` fetching — decided against (Ditto repo only).
- `skills remove` — Android CLI has no equivalent; not planned.
- Making the repo public removes the `GITHUB_TOKEN` dance (tracked in the M8 open deps).
