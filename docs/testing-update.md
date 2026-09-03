# Manual testing — `dittosh update`

Checklist for `dittosh update`: the self-update command — channel detection
(npm vs Homebrew), `--check`, and the upgrade run.

Every command is copy-pasteable. Run top to bottom; check off what passes.
Note anything off as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`). All
of these **hit the network** (npm registry), and the final section actually
upgrades your install — skip it unless you mean it.

Pre-release note: until `@dittolive/cli` is published to npm, the registry
lookup 404s — expect `Update check failed: npm registry HTTP 404`, exit 1.
The checks below describe the behavior once the package is published.

## 1. Check only

- [ ] **Up to date**
  ```bash
  dittosh update --check ; echo "exit: $?"
  ```
  Expect: `Already up to date (X.Y.Z).`, `exit: 0`.

- [ ] **Update available** (only when the registry is ahead): same command.
  Expect: `Update available: current → latest` on stdout, and
  `upgrade with: <channel-specific command>` on **stderr**. Still `exit:
  0` — `--check` never upgrades.

- [ ] **The result is cached** — afterwards:
  ```bash
  dittosh version
  ```
  Expect: the `update` line now reflects the check (`up to date (…)` or
  `X.Y.Z available …`) instead of `unknown (never checked)`.

## 2. Upgrade (destructive — skips unless you're testing a release bump)

- [ ] **Channel-aware upgrade**
  ```bash
  dittosh update
  ```
  Expect: with nothing available, `Already up to date (X.Y.Z).` — safe.
  With an update available on a Homebrew install: runs `brew update && brew
  upgrade dittosh` (npm global: `npm i -g @dittolive/cli@latest`), prints
  `running: …` on stderr, then `Updated to X.Y.Z.`, exit 0. A failed
  package-manager run prints the manual command and exits 1.

- [ ] **Unknown channel gives manual instructions** (only reproducible from
  an unidentified install, e.g. a bare `node dist/cli.js`):
  Expect: `Can't tell how this install was made. Upgrade manually:` with
  both the brew and npm commands, exit 1.
