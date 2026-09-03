# Manual testing — `dittosh version`

Checklist for `dittosh version`: CLI + Ditto SDK versions, install channel,
update status, token expiry, and paths.

Every command is copy-pasteable. Run top to bottom; check off what passes.
Note anything off as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

## 1. Text form (default)

- [ ] **Aligned key/value list**
  ```bash
  dittosh version
  ```
  Expect: eight dim-keyed lines — `version`, `ditto_sdk`, `channel`
  (`npm global`, `homebrew`, or `dev checkout`), `update`, `token_expires`
  (date + days left), `data_dir`, `platform` (`darwin/arm64`, …), `node`.

- [ ] **Never hits the network** — run it offline (or with Wi-Fi off).
  Expect: instant output; the `update` line comes from the cached update
  check (`unknown (never checked)` on a fresh config dir), not a live
  query.

## 2. JSON form

- [ ] **Parses cleanly**
  ```bash
  dittosh version --format json | jq .
  ```
  Expect: an object with the same eight keys.

- [ ] **Reports the SDK version**
  ```bash
  dittosh version --format json | jq -r .ditto_sdk
  ```
  Expect: `5.1.0`.

- [ ] **Data dir is absolute and expandable**
  ```bash
  dittosh version --format json | jq -r .data_dir
  ```
  Expect: the OS-default path
  (e.g. `~/Library/Application Support/dittosh` on macOS), or your
  `DITTOSH_DATA_DIR` override when set.

## 3. Usage errors

- [ ] **Bad `--format`**
  ```bash
  dittosh version --format yaml ; echo "exit: $?"
  ```
  Expect: `--format must be one of text, json — got "yaml"`, `exit: 2`.
