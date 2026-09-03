# Manual testing — `dittosh dql doctor`

Checklist for `dittosh dql doctor`: the environment health check —
platform, node, data directory, token, SDK, and lock.

Every command is copy-pasteable. Run top to bottom; check off what passes.
Note anything off as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

## 1. Healthy run

- [ ] **All six checks pass**
  ```bash
  dittosh dql doctor ; echo "exit: $?"
  ```
  Expect: six `✓` lines —
  `platform` (darwin/arm64, linux/x64, linux/arm64, or windows/x64),
  `node`, `data directory`, `token`, `sdk`, `lock` — each with a detail
  after the em dash. `exit: 0`.

- [ ] **`-d` override is honored**
  ```bash
  mkdir -p /tmp/mt-doctor
  dittosh dql doctor -d /tmp/mt-doctor
  ```
  Expect: the `data directory` line shows `/tmp/mt-doctor`; still all `✓`.

## 2. Failure mapping

- [ ] **Bogus `-d` value fails the data-directory check**
  ```bash
  dittosh dql doctor -d -- ; echo "exit: $?"
  ```
  Expect: `✗ data directory — bogus --data-dir value: expected a directory
  path`, the other checks still run, `exit: 3`.

- [ ] **Lock failure → 4** (optional, two terminals): start the REPL in one
  terminal (`dittosh dql`), then in another:
  ```bash
  dittosh dql doctor ; echo "exit: $?"
  ```
  Expect: `✗ lock — …` (in use by another dittosh process), `exit: 4` —
  lock failures get their own exit code, everything else is 3.

- [ ] **Unwritable data dir → 3** (optional)
  ```bash
  mkdir -p /tmp/mt-doctor-ro && chmod 555 /tmp/mt-doctor-ro
  dittosh dql doctor -d /tmp/mt-doctor-ro ; echo "exit: $?"
  chmod 755 /tmp/mt-doctor-ro
  ```
  Expect: the data-directory (or lock) check fails, `exit: 3`.

## 3. Cleanup

- [ ] **Remove scratch dirs**
  ```bash
  rm -rf /tmp/mt-doctor /tmp/mt-doctor-ro
  ```
