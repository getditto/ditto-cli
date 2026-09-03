# Manual testing — `dittosh dql delete-store`

Checklist for `dittosh dql delete-store`: permanently deleting the local
store — the whole data directory, all collections, indexes, and files
(lock files included). Contrast with `dittosh dql dataset reset <name>`,
which only EVICTs a dataset's documents.

Every command is copy-pasteable. Run top to bottom; check off what passes.
Note anything off as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

## 1. Setup

- [ ] **A store with something in it**
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: `Loaded 10000 documents into 1 collections`.

## 2. The confirmation gate

- [ ] **Without `-y` it refuses**
  ```bash
  dittosh dql delete-store ; echo "exit: $?"
  ```
  Expect: `This permanently deletes the store at … — all collections,
  indexes, and files. Re-run with --yes to confirm.`, `exit: 2`, and the
  store is untouched (there is no interactive prompt — `-y` is the only
  confirmation).

- [ ] **Data still there**
  ```bash
  dittosh dql "SELECT count(*) AS n FROM movies"
  ```
  Expect: `[{"n":10000}]`.

## 3. Deleting

- [ ] **`-y` deletes**
  ```bash
  dittosh dql delete-store -y ; echo "exit: $?"
  ```
  Expect: `Deleted the store at …`, `exit: 0`.

- [ ] **The directory is really gone**
  ```bash
  dittosh version --format json | jq -r .data_dir | xargs ls 2>&1
  ```
  Expect: `ls: …: No such file or directory` — the whole data directory,
  lock files included, was removed. (The next store-opening command
  re-creates it.)

- [ ] **Deleting an absent store is a no-op success**
  ```bash
  dittosh dql delete-store -y ; echo "exit: $?"
  ```
  Expect: `No store at … — nothing to delete.`, `exit: 0`.

## 4. Refusals

- [ ] **Absurd targets are refused** — `$HOME`, the current directory, and
  the filesystem root are never valid stores:
  ```bash
  dittosh dql delete-store -y -d ~ ; echo "exit: $?"
  dittosh dql delete-store -y -d . ; echo "exit: $?"
  ```
  Expect: `Refusing to delete … — that's not a dittosh data directory.`,
  `exit: 2`, nothing deleted. (**Do not** improvise other targets here.)

- [ ] **Bogus `-d` value**
  ```bash
  dittosh dql delete-store -y -d -- ; echo "exit: $?"
  ```
  Expect: `-d/--data-dir requires a directory path`, `exit: 2`.

- [ ] **Locked store → 4** (optional, two terminals): load a store, start
  the REPL in one terminal (`dittosh dql`), then in another:
  ```bash
  dittosh dql delete-store -y ; echo "exit: $?"
  ```
  Expect: a "in use by another dittosh process" message, `exit: 4` — a
  store another process holds open is never deleted. `.exit` the REPL and
  re-run: deletes.

## 5. Never gated on the token

- [ ] **Deletion works even with a broken/expired token** — deleting files
  must always be possible. (Dev-build check: point `OFFLINE_TOKEN` at junk
  in `.env`, or temporarily move `.env` and rely on an expired embedded
  token.) Expect: the store is deleted, exit 0 — no token error.
