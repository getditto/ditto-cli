# Manual testing — `dittosh skills` (installing agent files)

Checklist for the `dittosh skills` command group: `add`, `list`, and
`update`. These commands fetch the DQL skill from the private
`getditto/agent-skills` repo on GitHub and write it into AI coding agents'
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
`cursor`, `copilot`, `windsurf`. Global installs go under the agent's home
dir (`~/.claude/skills`, `~/.agents/skills`, …); `cursor`/`copilot`/
`windsurf` are project-only. Every install drops a `.dql-skill.json` marker
next to the skill files — that's what `list`/`update` read.

## 1. Project-local install (`skills add --project`)

- [ ] **Install into two agents**
  ```bash
  dittosh skills add --project /tmp/mt-skills --agent claude,opencode
  ```
  Expect (piped → JSON): one row per agent with `status: "installed"`,
  `ref: "main"`, and `where` pointing at `/tmp/mt-skills/.claude/skills/dql`
  and `/tmp/mt-skills/.agents/skills/dql`. Progress
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

## 4. Global install (optional — writes real agent config dirs)

- [ ] **Install globally for one agent**
  ```bash
  dittosh skills add --agent claude
  ```
  Expect: `where` is `~/.claude/skills/dql`; `dittosh skills list` now shows
  a `global` row for it. Re-run without `--force` → `skipped`. Clean up by
  removing `~/.claude/skills/dql` afterwards if you don't want to keep it.

- [ ] **Default agent selection** (optional)
  ```bash
  dittosh skills add
  ```
  Expect: installs into **every detected** agent (those whose global dir
  exists). With none detectable: `No agents detected — pass --agent
  explicitly…`, exit 2.

## 5. Cleanup

- [ ] **Remove the scratch dirs**
  ```bash
  rm -rf /tmp/mt-skills /tmp/mt-skills-empty
  ```
