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

## 3. Report bundle (`--report`)

- [ ] **Top-level alias**
  ```bash
  dittosh doctor ; echo "exit: $?"
  ```
  Expect: the same checks as `dittosh dql doctor`.

- [ ] **Write a report after a failure**
  ```bash
  dittosh dql dataset load movies -d /tmp/mt-doctor --docs 100
  dittosh dql "SELEC oops FROM movies" -d /tmp/mt-doctor   # fails, exit 1
  cd /tmp && dittosh doctor -d /tmp/mt-doctor --report /tmp/mt-report.tar.gz
  mkdir -p /tmp/mt-report && tar -xzf /tmp/mt-report.tar.gz -C /tmp/mt-report
  ls /tmp/mt-report/mt-report
  ```
  Expect: stderr lists the contents and the issue link; the folder holds
  `report.md`, `report.json`, `ditto-support-bundle.tar`. `report.md` shows the
  `movies` collection with 100 documents, the failed `SELEC` command and its
  error under "Last error", credentials as "set (value hidden)", and `~` for
  your home folder.

- [ ] **Leave parts out**
  ```bash
  dittosh doctor -d /tmp/mt-doctor --report /tmp/mt-report2.tar.gz --no-store --no-sdk-bundle
  tar -tzf /tmp/mt-report2.tar.gz
  ```
  Expect: only `report.md` and `report.json`; the report says both parts were left out.

- [ ] **SDK bundle only, and the rate limit**
  ```bash
  for i in 1 2 3 4; do dittosh dql support-bundle -d /tmp/mt-doctor -o /tmp/mt-sb$i.tar; done
  dittosh dql support-bundle -d /tmp/mt-doctor --list
  tar -tf /tmp/mt-sb1.tar
  ```
  Expect: each run saves a `.tar` (`ditto-logs.log.gz`, `device_logs_METADATA.json`,
  `config_snapshot.json`). Once the store has made 3 bundles in 10 minutes
  (the report above counts), a yellow note says a new one wasn't allowed and the
  newest existing bundle was saved. `--list` shows the bundles.

- [ ] **`--debug`**
  ```bash
  dittosh --debug dql "SELECT count(*) FROM movies" -d /tmp/mt-doctor 2>/tmp/mt-debug.log | jq .
  grep -c DEBUG /tmp/mt-debug.log
  ```
  Expect: `jq` prints the count (stdout clean); the log has DEBUG lines.

## 4. Cleanup

- [ ] **Remove scratch dirs**
  ```bash
  rm -rf /tmp/mt-doctor /tmp/mt-doctor-ro /tmp/mt-report* /tmp/mt-sb*.tar /tmp/mt-debug.log
  ```
