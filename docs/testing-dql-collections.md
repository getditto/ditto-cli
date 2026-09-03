# Manual testing — `dittosh dql collections`

Checklist for `dittosh dql collections`: listing collections from
`system:collections`.

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off as a comment under the
failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

Known upstream quirk (**not** a bug): `SELECT * FROM system:collections`
returns rows only on the *first* `execute` of a session. The
`dql collections` command always opens a fresh session, so it always sees
rows — but hand-rolled repeats of that statement inside one REPL session
can come back empty.

## 1. Setup

- [ ] **Clean store + the movies dataset** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: `Loaded 10000 documents into 1 collections`.

## 2. Listing

- [ ] **Collections after a load**
  ```bash
  dittosh dql collections
  ```
  Expect (piped → JSON): a row per collection —
  `{"_id":"default:movies","datasource":"default","name":"movies"}` plus
  the `__feature_flags` system collection. On a TTY: a fitted table.

- [ ] **Fresh store lists only system collections**
  ```bash
  dittosh dql delete-store -y
  dittosh dql collections
  ```
  Expect: just `__feature_flags` — no user collections yet (opening the
  store materializes the data directory).

- [ ] **New collections appear after import**
  ```bash
  echo '[{"a":1}]' > /tmp/mt-coll.json
  dittosh dql import /tmp/mt-coll.json imported_things
  dittosh dql collections
  ```
  Expect: `imported_things` now listed alongside the rest.

## 3. Cleanup

- [ ] **Reset the store and scratch files**
  ```bash
  dittosh dql delete-store -y
  rm -f /tmp/mt-coll.json
  ```
