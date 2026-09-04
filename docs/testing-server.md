# Manual testing — `dittosh server` (portal HTTP API)

Checklist for the `server` group: DQL over HTTP against Ditto Server
(execute / remote-execute), attachments, RBAC (roles/users), webhook secrets,
and the config resolution contract (flags > shell env > cwd `.env`).

The legacy pre-DQL store API (find/findbyid/count/write) is deliberately not
supported — `server execute` covers it all with full DQL.

Every command is copy-pasteable once the config exists. Run top to bottom;
check off what passes. Note anything off (wrong exit codes, noise on stdout)
as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`) and the
retail dataset is synced to the portal app (collections: `stores`,
`categories`, `products`, `customers`, `inventory`, `orders`, `order_items`).

Two things that are **not** bugs:

- Piped stdout is always **JSON**, never the table.
- Progress, notes (`(transactionId …)`), warnings, and errors live on
  **stderr** — `dittosh server execute … | jq` stays clean.

## 1. Setup

- [ ] **`.env` in the working directory** (what `npm run dev` and the release
      build both read):
  ```bash
  DITTOSH_SERVER_URL=https://xxxx.cloud.dittolive.app/your-app-id
  DITTOSH_SERVER_API_KEY=your-api-key
  ```
  The `https://` prefix is added when missing; cleartext `http://` is rejected
  for non-local hosts (the key would transit unencrypted — loopback is exempt
  for local testing). Aliases `DITTO_CLOUD_URL` / `DITTO_API_KEY` also work.
  Layers mix per key (a cwd `.env` URL + a shell-env key sends that key to the
  `.env`'s host) — `dittosh server doctor` shows where each value came from.

- [ ] **No config → exit 3 with guidance** (run from a directory with no
      `.env`):
  ```bash
  cd "$(mktemp -d)" && dittosh server execute "SELECT 1"; echo "exit: $?"
  ```
  Expect: `No Ditto Server URL configured…` on stderr, `exit: 3`, nothing on
  stdout.

## 2. `server doctor`

- [ ] **All green**
  ```bash
  dittosh server doctor; echo "exit: $?"
  ```
  Expect: `✓ config` (shows URL + where each credential came from), `✓
  connection`, `✓ auth — API key accepted — probe query ran (transactionId
  …)`, `exit: 0`. The API key value must **never** appear.

- [ ] **Bad key → diagnosis**
  ```bash
  DITTOSH_SERVER_API_KEY=definitely-wrong-key dittosh server doctor; echo "exit: $?"
  ```
  Expect: config ✓, connection ✓, `✗ auth — HTTP 401 … check the API key`,
  `exit: 3`.

- [ ] **Unreachable URL → connection fails**
  ```bash
  dittosh server doctor --url http://127.0.0.1:1/app; echo "exit: $?"
  ```
  Expect: `✗ connection — Cannot reach …`, auth skipped, `exit: 3`.

## 3. `server execute` (POST /api/v5/store/execute)

- [ ] **Basic SELECT (piped → JSON)**
  ```bash
  dittosh server execute "SELECT * FROM customers LIMIT 3"
  ```
  Expect: JSON array of 3 customer docs on stdout, `(transactionId …)` on
  stderr, exit 0.

- [ ] **Table on a terminal** (run in a real terminal)
  ```bash
  dittosh server execute "SELECT first_name, last_name, email FROM customers LIMIT 5"
  ```
  Expect: a box table + `5 rows` footer.

- [ ] **Parameter binding** (`-p` JSON-parses values)
  ```bash
  dittosh server execute "SELECT count(*) AS n FROM customers WHERE first_name = :name" -p name=Carolyn
  dittosh server execute "SELECT * FROM products WHERE price > :p LIMIT 3" --args '{"p":50}'
  ```
  Expect: a count for Carolyn; 3 products.

- [ ] **Aggregates + ordering**
  ```bash
  dittosh server execute "SELECT city, count(*) AS n FROM stores GROUP BY city ORDER BY n DESC LIMIT 5"
  ```

- [ ] **EXPLAIN as a plain statement**
  ```bash
  dittosh server execute "EXPLAIN SELECT * FROM orders WHERE store_id = 'store_seattle'"
  ```
  Expect: one JSON row with a `plan`.

- [ ] **--api-version v4 (strict mode)**
  ```bash
  dittosh server execute --api-version v4 "SELECT count(*) AS n FROM customers"
  ```
  Expect: same count as v5.

- [ ] **--txn-id consistency header**
  ```bash
  dittosh server execute "SELECT count(*) AS n FROM customers" --txn-id 1
  ```
  Expect: normal result (txn 1 is long past).

- [ ] **Batch from stdin** (one HTTP call per statement)
  ```bash
  printf "SELECT count(*) AS n FROM customers;\nSELECT count(*) AS n FROM orders;\n" | dittosh server execute
  ```
  Expect: two JSON arrays on stdout, `2 ok, 0 failed (of 2)` on stderr.

- [ ] **Batch stops on failure; --continue-on-error doesn't**
  ```bash
  printf "SELECT 1 FROM stores;\nSELEC broken;\nSELECT 2 FROM stores;\n" | dittosh server execute; echo "exit: $?"
  printf "SELECT 1 FROM stores;\nSELEC broken;\nSELECT 2 FROM stores;\n" | dittosh server execute --continue-on-error; echo "exit: $?"
  ```
  Expect: first run stops after the error (`exit: 1`); second runs all three
  (`2 ok, 1 failed (of 3)`, `exit: 1`).

- [ ] **DQL error → exit 1, stdout stays clean**
  ```bash
  out=$(dittosh server execute "SELEC broken"); code=$?; echo "stdout bytes: ${#out}, exit: $code"
  ```
  Expect: `stdout bytes: 0, exit: 1`, `Query error: …` on stderr.

- [ ] **Write round-trip on a scratch collection**
  ```bash
  dittosh server execute "INSERT INTO dittosh_cli_probe DOCUMENTS ({'_id':'p1','note':'hello'})"
  dittosh server execute "SELECT * FROM dittosh_cli_probe WHERE _id = 'p1'"
  dittosh server execute "UPDATE dittosh_cli_probe SET note = 'updated' WHERE _id = 'p1'"
  dittosh server execute "DELETE FROM dittosh_cli_probe WHERE _id = 'p1'"
  dittosh server execute "SELECT count(*) AS n FROM dittosh_cli_probe"
  ```
  Expect: `OK` + `1 document mutated` (stderr) per write; the SELECT shows the
  doc between INSERT and DELETE; final count `0`.

- [ ] **-o export**
  ```bash
  dittosh server execute "SELECT * FROM categories" -o /tmp/categories.json && head -c 200 /tmp/categories.json
  ```

- [ ] **Usage errors → exit 2, no request made**
  ```bash
  dittosh server execute "SELECT 1" -e "SELECT 2"; echo "exit: $?"
  dittosh server execute "SELECT 1; SELECT 2"; echo "exit: $?"
  dittosh server execute "DELETE FROM customers" -o /tmp/x.json; echo "exit: $?"
  ```
  (All exit 2; the last one refuses because mutations produce no rows.)

## 4. `server remote-execute` (POST /api/v5/sync/remote_execute)

- [ ] **SYNC CONTEXT required (client-side)**
  ```bash
  dittosh server remote-execute "SELECT 1"; echo "exit: $?"
  ```
  Expect: `must start with a SYNC CONTEXT clause`, exit 2.

- [ ] **Runs against connected peers** (needs at least one small peer online;
      otherwise an empty result array)
  ```bash
  dittosh server remote-execute "SYNC CONTEXT ( PEERS WHERE peerKeyString = '<peer-key>' ) SELECT * FROM system:system_info"
  ```
  Expect: JSON array with one entry per responding peer (`peer`,
  `elapsedMilliseconds`, `items`).

## 5. Attachments

- [ ] **Upload → id/len**
  ```bash
  printf 'hello attachment' > /tmp/att.txt
  dittosh server attachment upload /tmp/att.txt
  ```
  Expect: `{"id": "<attachment-id>", "len": 16}`.

- [ ] **Download round-trip**
  ```bash
  dittosh server attachment get <id-from-above> -o /tmp/att-out.txt && diff /tmp/att.txt /tmp/att-out.txt
  dittosh server attachment get <id-from-above> | cmp - /tmp/att.txt   # piped: bytes on stdout
  ```

- [ ] **Binary on a TTY is refused** (run in a real terminal)
  ```bash
  dittosh server attachment get <id>; echo "exit: $?"
  ```
  Expect: `Refusing to write binary to the terminal…`, exit 2.

## 6. RBAC (roles / users) — portal-internal, undocumented

- [ ] **roles list**
  ```bash
  dittosh server roles list
  ```
  Expect: a row per role (empty list if none) — name, version, description,
  collection_permissions, grant_remote_query.

- [ ] **roles create → list → delete** (destructive; use a throwaway name)
  ```bash
  dittosh server roles create dittosh-probe --description "CLI test role" --permissions read_only
  dittosh server roles list | grep dittosh-probe
  dittosh server roles delete dittosh-probe -y
  ```
  Expect: created note on stderr; visible in the list; deleted.

- [ ] **roles delete without -y, piped → exit 2**
  ```bash
  echo | dittosh server roles delete dittosh-probe; echo "exit: $?"
  ```

- [ ] **users list** (needs auth/RBAC configured for the app — otherwise
      `HTTP 404 … may not support the users endpoint`, exit 1)
  ```bash
  dittosh server users list --limit 50
  dittosh server users list --user-id "auth0|some-id"
  ```

- [ ] **users set-roles / delete** (destructive — only against a test user)
  ```bash
  dittosh server users set-roles "auth0|test-user" dittosh-probe
  dittosh server users delete "auth0|test-user" -y
  ```

## 7. Webhook secrets — portal-internal, undocumented

**Prerequisite:** the provider must already exist — i.e. an auth webhook must
be configured for the app (portal → app → Auth). This API cannot create
providers: against a nonexistent provider, `list` and `create` both fail with
`HTTP 400 … Provider '<name>' not found` (exit 1). Verified live.

Destructive — secrets sign your auth webhook traffic. Use a dedicated test
provider, not your production one.

- [ ] **Nonexistent provider → clean error**
  ```bash
  dittosh server webhook-secrets list --provider definitely-not-a-provider; echo "exit: $?"
  ```
  Expect: `HTTP 400 … Provider 'definitely-not-a-provider' not found`, exit 1
  (a 404 answers `[]` on older deployments).

- [ ] **list → create → list → rotate → delete** (against an EXISTING test
      provider — substitute its real name)
  ```bash
  PROVIDER=my-test-webhook
  dittosh server webhook-secrets list --provider "$PROVIDER"
  dittosh server webhook-secrets create --provider "$PROVIDER" --not-after 2027-01-01T00:00:00Z
  SECRET=$(dittosh server webhook-secrets list --provider "$PROVIDER" --format json | jq -r '.[0].secret')
  dittosh server webhook-secrets rotate --provider "$PROVIDER" --secret "$SECRET" --not-after 2027-06-01T00:00:00Z
  dittosh server webhook-secrets delete --provider "$PROVIDER" --secret "$SECRET" -y
  ```
  Expect: existing secrets (or `[]`) initially; create prints the new secret
  JSON; rotate prints the replacement secret; delete confirms on stderr.

- [ ] **Validation: bad date → exit 2**
  ```bash
  dittosh server webhook-secrets create --provider "$PROVIDER" --not-after someday; echo "exit: $?"
  ```

## 8. Config precedence

- [ ] **Flags beat env beat .env**
  ```bash
  dittosh server execute "SELECT count(*) AS n FROM customers" \
    --url "$(grep ^DITTOSH_SERVER_URL= .env | cut -d= -f2-)" \
    --api-key "$(grep ^DITTOSH_SERVER_API_KEY= .env | cut -d= -f2-)"
  ```
  Expect: normal result. (`-f2-` keeps `=`-padding in the key.) Note that
  `--api-key` on argv is visible in `ps` and your shell history — prefer the
  env/.env layers for anything but throwaway shells.

- [ ] **Bad --api-version → exit 2 before any request** (bad flag value = usage)
  ```bash
  dittosh server execute "SELECT 1" --api-version v9; echo "exit: $?"
  ```
