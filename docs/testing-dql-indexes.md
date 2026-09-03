# Manual testing — `dittosh dql indexes`

Checklist for `dittosh dql indexes [collection]`: listing indexes from
`system:indexes`, globally or scoped to one collection.

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off as a comment under the
failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

## 1. Setup

- [ ] **Clean store + the movies dataset** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: `Loaded 10000 documents into 1 collections`.

## 2. Listing

- [ ] **No indexes on a fresh load**
  ```bash
  dittosh dql indexes
  ```
  Expect (piped → JSON): `[]` — `dataset load` never creates indexes.
  (Setup indexes come from `dataset run --setup` or ADVISE.)

- [ ] **Create one, see it**
  ```bash
  dittosh dql "CREATE INDEX IF NOT EXISTS mt_rated ON movies (rated)"
  dittosh dql indexes
  ```
  Expect: one row —
  `{"_id":"movies.mt_rated","collection":"movies","fields":[{"direction":"asc","key":["rated"]}]}`.

- [ ] **Scope to a collection**
  ```bash
  dittosh dql "CREATE INDEX IF NOT EXISTS mt_runtime ON movies (runtime)"
  dittosh dql indexes movies
  ```
  Expect: both `mt_rated` and `mt_runtime` rows, nothing from other
  collections.

- [ ] **Unknown collection is empty, not an error**
  ```bash
  dittosh dql indexes nope ; echo "exit: $?"
  ```
  Expect: `[]`, `exit: 0`.

- [ ] **Dropped indexes disappear**
  ```bash
  dittosh dql "DROP INDEX mt_runtime ON movies"
  dittosh dql indexes movies
  ```
  Expect: only `mt_rated` remains.

## 3. Cleanup

- [ ] **Reset the store**
  ```bash
  dittosh dql delete-store -y
  ```
