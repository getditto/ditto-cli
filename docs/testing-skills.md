# Manual testing — `dittosh skills` (installing agent files)

Checklist for the `dittosh skills` command group: `add`, `list`,
`update`, and `versions`. These commands fetch skills from the private
`getditto/agent-skills` repo on GitHub and write them into AI coding agents'
config dirs.

Every command is copy-pasteable. Run top to bottom; check off what passes.
Note anything off (wrong exit codes, noise on stdout, files landing in the
wrong place) as a comment under the failing test.

Prereqs:

- the release build is installed (`scripts/install-release.sh`)
- **network access**, and until `getditto/agent-skills` goes public a token:
  ```bash
  export GITHUB_TOKEN=$(gh auth token)
  ```
- a scratch project dir for the destructive tests:
  ```bash
  rm -rf /tmp/mt-skills && mkdir -p /tmp/mt-skills
  ```

Known agents (for `--agent`): `claude`, `opencode`, `codex`, `gemini`,
`antigravity`, `cursor`, `copilot`, `windsurf`. Global installs go under the agent's home
dir (`~/.claude/skills`, `~/.agents/skills`, …); `cursor`/`copilot`/
`windsurf` are project-only. Every install drops a `.dql-skill.json` marker
next to the skill files — that's what `list`/`update` read.

## 1. Project-local install (`skills add --project`)

- [ ] **Install into two agents**
  ```bash
  dittosh skills add --project /tmp/mt-skills --agent claude,opencode
  ```
  Expect (piped → JSON): one row per agent with `status: "installed"`,
  `ref: "main"`, and `where` pointing at `/tmp/mt-skills/.claude/skills/write-dql`
  and `/tmp/mt-skills/.agents/skills/write-dql`. Progress
  (`Resolving…`/`Fetching…`) on **stderr**. Exit 0.

- [ ] **Files actually landed**
  ```bash
  ls /tmp/mt-skills/.claude/skills/dql /tmp/mt-skills/.agents/skills/dql
  ```
  Expect: skill files (e.g. `best-practices.md`) plus the `.dql-skill.json`
  marker in each dir.

- [ ] **Re-install without `--force` skips**
  ```bash
  dittosh skills add --project /tmp/mt-skills --agent claude
  ```
  Expect: `status: "skipped"`, detail
  `already installed (main) — pass --force to overwrite`. Exit 0.

- [ ] **`--force` overwrites**
  ```bash
  dittosh skills add --project /tmp/mt-skills --agent claude --force
  ```
  Expect: `status: "installed"` again. Exit 0.

- [ ] **Unknown agent is reported, not silent**
  ```bash
  dittosh skills add --project /tmp/mt-skills --agent bogus ; echo "exit: $?"
  ```
  Expect: a row with `status: "skipped"` and detail
  `unknown agent (known: claude, opencode, codex, gemini, …)`; a
  `1 agent skipped` warning on stderr; `exit: 2` (every target failed).

- [ ] **`--project` path must exist**
  ```bash
  dittosh skills add --project /tmp/mt-skills-nope --agent claude ; echo "exit: $?"
  ```
  Expect: `--project path does not exist: …`, `exit: 2`. Nothing is fetched.

- [ ] **Private repo without a token fails cleanly**
  ```bash
  env -u GITHUB_TOKEN dittosh skills add --project /tmp/mt-skills --agent codex ; echo "exit: $?"
  ```
  Expect: `The getditto/agent-skills repo is private (or unreachable). …`
  with the `GITHUB_TOKEN=$(gh auth token)` hint, `exit: 1`. (Skip if the
  repo has gone public.)

## 2. Listing (`skills list`)

- [ ] **Project scan finds both installs**
  ```bash
  dittosh skills list --project /tmp/mt-skills
  ```
  Expect (piped → JSON): rows for claude + opencode with `skill: "dql"`,
  `ref: "main"`, an ISO `installed` timestamp, `channel: "project"`, and the
  install paths.

- [ ] **Empty project reports nothing without breaking JSON**
  ```bash
  mkdir -p /tmp/mt-skills-empty
  dittosh skills list --project /tmp/mt-skills-empty
  ```
  Expect: `[]` on stdout (piped → JSON), and the hint
  `no skills installed — install with `dittosh skills add`` on **stderr**.

- [ ] **Global list is read-only and safe**
  ```bash
  dittosh skills list
  ```
  Expect: a row per skill found under each detected agent's global dir
  (`channel: "global"`); on a machine with none, `(no skills installed)`.
  Writes nothing.

## 3. Refresh (`skills update`)

- [ ] **Up-to-date installs are a no-op**
  ```bash
  dittosh skills update --project /tmp/mt-skills
  ```
  Expect: `all dql installs already on main`. No re-download (no
  `Fetching…` line). Exit 0.

- [ ] **Nothing installed → nothing to update**
  ```bash
  dittosh skills update --project /tmp/mt-skills-empty
  ```
  Expect: `(no dql skill installed — use `dittosh skills add`)` on stdout,
  a note on stderr. Exit 0.

- [ ] **Stale install gets refreshed** (optional — simulate by editing a
  marker): change `"ref"` in
  `/tmp/mt-skills/.claude/skills/dql/.dql-skill.json` to `"old-ref"`, then:
  ```bash
  dittosh skills update --project /tmp/mt-skills
  ```
  Expect: the claude row shows `status: "updated"` with detail
  `old-ref → main`; opencode (still current) is untouched.

## 4. Multi-skill, versions & pinning (new)

- [ ] **Install a named skill positionally**
  ```bash
  dittosh skills add swift-sdk --project /tmp/mt-skills --agent claude
  ```
  Expect: row `skill: "swift-sdk"`, files at
  `/tmp/mt-skills/.claude/skills/swift-sdk/`. Exit 0.

- [ ] **Install everything**
  ```bash
  dittosh skills add --all --project /tmp/mt-skills --agent claude
  ```
  Expect: one row per upstream skill (write-dql, swift-sdk, kotlin-sdk, …),
  all `installed`. One fetch (stderr shows a single `Fetching…`).

- [ ] **Companion skills install together (agent-skills v0.6.0+)**
  ```bash
  rm -rf /tmp/mt-skills/.claude/skills
  dittosh skills add js-node --project /tmp/mt-skills --agent claude
  ```
  Expect: stderr note `js-node links to companion skills js-expo,
  js-react-native, js-sdk, js-web, native-app-config — installing them too
  (--no-deps to skip)`.
  Six `installed` rows; companions have detail `companion of js-node`. Then
  `dittosh skills add swift-sdk --project /tmp/mt-skills --agent claude` shows
  `native-app-config` as `present`, exit 0.

- [ ] **`--no-deps` installs only the named skill**
  ```bash
  rm -rf /tmp/mt-skills/.claude/skills
  dittosh skills add js-expo --no-deps --project /tmp/mt-skills --agent claude
  ```
  Expect: one row; only `.claude/skills/js-expo/` exists, and its
  `.dql-skill.json` has `"deps": false`. A later
  `dittosh skills update js-expo --project /tmp/mt-skills --ref <older-or-newer tag>`
  updates only js-expo and adds no companions.

- [ ] **No companions for Copilot/Windsurf**
  ```bash
  mkdir -p /tmp/mt-skills/.github
  dittosh skills add js-web --project /tmp/mt-skills --agent copilot,claude
  ```
  Expect: claude gets all six JS skills; copilot gets only
  `.github/instructions/js-web.instructions.md`.

- [ ] **Unknown skill lists what's available**
  ```bash
  dittosh skills add nope --project /tmp/mt-skills --agent claude
  ```
  Expect: exit 2, stderr `unknown skill 'nope' — available: …`, empty stdout.

- [ ] **Old name still works (alias)**
  ```bash
  dittosh skills add dql --project /tmp/mt-skills --agent claude --force
  ```
  Expect: stderr note `skill 'dql' is now 'write-dql' upstream`, files land
  under `skills/write-dql/`.

- [ ] **List published releases**
  ```bash
  dittosh skills versions
  ```
  Expect: table of tags, newest first marked `latest`, with a
  `slim_asset` column (`yes` once the Release workflow has run). Before any
  release exists: `installs track the main branch`.

- [ ] **Pin a version, then move off it**
  ```bash
  dittosh skills add write-dql --ref v0.1.0 --project /tmp/mt-skills --agent claude --force
  dittosh skills list --project /tmp/mt-skills   # ref column shows v0.1.0
  dittosh skills update --project /tmp/mt-skills # → latest, detail shows v0.1.0 → <latest>
  ```

- [ ] **Antigravity: project-local install**
  ```bash
  dittosh skills add swift-sdk --project /tmp/mt-skills --agent antigravity
  ```
  Expect: `where` is `/tmp/mt-skills/.agents/skills/swift-sdk` (shared with the
  opencode convention); row `agent: "antigravity"`, `status: "installed"`.

- [ ] **Antigravity: global install** (optional — writes the real Antigravity skills dir)
  ```bash
  dittosh skills add swift-sdk --agent antigravity
  ```
  Expect: `where` is `~/.gemini/config/skills/swift-sdk` (the current global
  dir; legacy `~/.gemini/antigravity/skills` is detection-only). Detection
  triggers on `~/.gemini/antigravity` (IDE) or `~/.gemini/config`. Clean up by
  removing `~/.gemini/config/skills/swift-sdk` afterwards if unwanted.

## 5. Global install (optional — writes real agent config dirs)

- [ ] **Install globally for one agent**
  ```bash
  dittosh skills add --agent claude
  ```
  Expect: `where` is `~/.claude/skills/write-dql`; `dittosh skills list` now shows
  a `global` row for it. Re-run without `--force` → `skipped`. Clean up by
  removing `~/.claude/skills/write-dql` afterwards if you don't want to keep it.

- [ ] **Default agent selection** (optional)
  ```bash
  dittosh skills add
  ```
  Expect: installs into **every detected** agent (those whose global dir
  exists). With none detectable: `No agents detected — pass --agent
  explicitly…`, exit 2.

## 6. Cleanup

- [ ] **Remove the scratch dirs**
  ```bash
  rm -rf /tmp/mt-skills /tmp/mt-skills-empty
  ```
