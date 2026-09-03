# Manual testing — `dittosh dql import`

Checklist for importing external JSON into a collection:
`dittosh dql import <file> <collection>`.

The standard import format is a **JSON array of objects**; NDJSON (one
object per line) is also accepted. `_id` is optional — docs without one get
a generated UUID. Imports upsert (`ON ID CONFLICT DO UPDATE`), so files
*with* `_id`s re-import cleanly; files *without* duplicate on re-import.

Every command is copy-pasteable and uses the default data dir. Run top to
bottom; check off what passes. Note anything off as a comment under the
failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

Not a bug: the ~7 `warning:`/`INFO` lines at startup are the SDK's native
tracing bootstrap on **stderr**; piped stdout stays clean.

## 1. Setup

- [ ] **Clean store** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  ```
  Expect: `Deleted the store at …` (or `No store at … — nothing to
  delete.`).

## 2. Happy paths

- [ ] **Import a JSON array**
  ```bash
  cat > /tmp/mt-import.json <<'EOF'
  [
    { "_id": "imp_1", "name": "Brass Hammer", "price": 24.99, "tags": ["hand", "clearance"] },
    { "_id": "imp_2", "name": "Cordless Drill", "price": 129.0 }
  ]
  EOF
  dittosh dql import /tmp/mt-import.json imported_products
  ```
  Expect: `Imported 2 documents into imported_products (…s)` on stdout,
  progress notes on stderr. The collection is created on first insert.

- [ ] **Query it back**
  ```bash
  dittosh dql "SELECT * FROM imported_products ORDER BY _id"
  ```
  Expect: the 2 docs, nested `tags` array intact.

- [ ] **Re-import is idempotent**
  ```bash
  dittosh dql import /tmp/mt-import.json imported_products
  dittosh dql "SELECT count(*) AS n FROM imported_products"
  ```
  Expect: still `[{"n":2}]` — upsert, not duplicates.

- [ ] **`--batch-size` is accepted**
  ```bash
  dittosh dql import /tmp/mt-import.json imported_products --batch-size 1
  ```
  Expect: `Imported 2 documents …` (one doc per INSERT batch).

- [ ] **Docs without `_id` get a generated UUID**
  ```bash
  echo '[{"name": "no id here"}]' > /tmp/mt-noid.json
  dittosh dql import /tmp/mt-noid.json imported_misc
  dittosh dql "SELECT _id, name FROM imported_misc"
  ```
  Expect: the doc carries a UUID `_id`. (Import the same file again and you
  get a second copy — stable identity needs `_id` in the file.)

- [ ] **NDJSON works too**
  ```bash
  printf '{"_id":"n1","v":1}\n{"_id":"n2","v":2}\n{"_id":"n3","v":3}\n' > /tmp/mt-import.ndjson
  dittosh dql import /tmp/mt-import.ndjson imported_nd
  ```
  Expect: `Imported 3 documents into imported_nd`.

- [ ] **`~` expands in the file path**
  ```bash
  cp /tmp/mt-import.json ~/mt-import.json
  dittosh dql import ~/mt-import.json imported_tilde
  rm ~/mt-import.json
  ```
  Expect: `Imported 2 documents into imported_tilde`.

## 3. Bad inputs (all exit 2, nothing written)

- [ ] **Missing file**
  ```bash
  dittosh dql import /tmp/mt-missing.json things ; echo "exit: $?"
  ```
  Expect: `Cannot read file: /tmp/mt-missing.json (…)`, `exit: 2`.

- [ ] **Not JSON at all**
  ```bash
  echo 'not json' > /tmp/mt-bad.json
  dittosh dql import /tmp/mt-bad.json things ; echo "exit: $?"
  ```
  Expect: `… invalid JSON — …` (or "expected a JSON array…"), `exit: 2`.

- [ ] **Empty file**
  ```bash
  : > /tmp/mt-empty.json
  dittosh dql import /tmp/mt-empty.json things ; echo "exit: $?"
  ```
  Expect: `… is empty — expected a JSON array of documents`, `exit: 2`.

- [ ] **Array containing a non-object**
  ```bash
  echo '[{"a":1}, 42]' > /tmp/mt-mixed.json
  dittosh dql import /tmp/mt-mixed.json things ; echo "exit: $?"
  ```
  Expect: `… document #2 is not a JSON object`, `exit: 2`.

- [ ] **Invalid collection name**
  ```bash
  dittosh dql import /tmp/mt-import.json "bad;name" ; echo "exit: $?"
  dittosh dql import /tmp/mt-import.json "1starts-with-digit" ; echo "exit: $?"
  ```
  Expect: `invalid collection name "…" — letters, digits, and underscores
  only (must not start with a digit)`, `exit: 2` both times.

- [ ] **Usage is validated before the store opens** — with the store locked
  (optional: hold it open via the REPL in another terminal), a bad import
  still reports the *usage* error (exit 2), never the lock (exit 4).

## 4. Cleanup

- [ ] **Reset the store and remove scratch files**
  ```bash
  dittosh dql delete-store -y
  rm -f /tmp/mt-import.json /tmp/mt-import.ndjson /tmp/mt-noid.json /tmp/mt-bad.json /tmp/mt-empty.json /tmp/mt-mixed.json
  ```
