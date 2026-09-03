# Manual testing — `dittosh dql` interactive REPL

Checklist for the interactive shell you get from a bare `dittosh dql` on a
terminal: statement entry, multi-line input, dot-commands, and the flags
that are refused in REPL mode.

Most of this file is **interactive by nature** — commands start the shell,
then you type at the `dql>` prompt. Run top to bottom; check off what
passes. Note anything off as a comment under the failing test.

Prereq: the release build is installed (`scripts/install-release.sh`).

Not a bug: the ~7 `warning:`/`INFO` lines at startup are the SDK's native
tracing bootstrap on **stderr**; results still render normally.

## 1. Setup

- [ ] **Clean store + the movies dataset** (destroys any existing store)
  ```bash
  dittosh dql delete-store -y
  dittosh dql dataset load movies
  ```
  Expect: `Loaded 10000 documents into 1 collections`.

## 2. Starting and stopping

- [ ] **Start it**
  ```bash
  dittosh dql
  ```
  Expect: a `dql>` prompt (plus help hint). No statement + interactive TTY
  = REPL.

- [ ] **Exit with `.exit`** — type `.exit` at the prompt. Expect: clean
  return to your shell, exit code 0 (`echo $?`).

- [ ] **Exit with Ctrl-D** — re-enter, press `Ctrl-D` at a fresh prompt.
  Expect: clean exit, code 0.

- [ ] **Exit with Ctrl-C** — re-enter, press `Ctrl-C` at a fresh prompt.
  Expect: clean exit (a Ctrl-C mid-statement just abandons the line).

## 3. Running statements

- [ ] **In the shell:**
  ```sql
  SELECT count(*) AS n FROM movies;
  SELECT _id.title, rated FROM movies LIMIT 3;
  ```
  Expect: fitted tables (same TTY rules as one-shot), a dim `(N ms)` timing
  note after **every** statement — always on in the shell, no flag needed.
  Long in-shell results page through less.

- [ ] **Mutations work and confirm**
  ```sql
  INSERT INTO movies DOCUMENTS ({'_id':{'id':'repl1','title':'REPL Test','year':'2026','type':'movie'},'rated':'G'});
  SELECT _id.title FROM movies WHERE _id.id = 'repl1';
  ```
  Expect: `OK`, then the `REPL Test` row.

- [ ] **A failed statement doesn't kill the shell**
  ```sql
  SELEC broken;
  SELECT count(*) FROM movies;
  ```
  Expect: a query error for the first, a note that the store is unchanged,
  then the second runs fine — same `dql>` prompt throughout.

## 4. Multi-line input

- [ ] **Continuation prompt until `;`**
  ```sql
  SELECT _id.title, rated
  FROM movies
  WHERE rated = 'PG'
  LIMIT 3;
  ```
  Expect: a continuation prompt on each line until the `;`, then the
  result.

- [ ] **Discard a half-typed statement** — start a multi-line statement,
  then type `.break` (or `.clear`) at the continuation prompt. Expect:
  buffer discarded, fresh `dql>` prompt, nothing executed.

## 5. Dot-commands

- [ ] **`.help`** — lists the dot-commands:
  `.collections`, `.indexes [name]`, `.break` / `.clear`, `.exit`.

- [ ] **`.collections`** — lists the `movies` collection (plus the
  `__feature_flags` system collection).

- [ ] **`.indexes`** — lists all indexes (`[]`-style empty on a fresh
  store); **`.indexes movies`** scopes to one collection.

- [ ] **Unsupported node:repl commands are refused politely** — `.editor`,
  `.load`, `.save`. Expect: `not supported in the DQL REPL (use -f to run
  files)` on stderr, shell stays up.

- [ ] **Dot-commands only fire at a fresh prompt** — a `.exit` *line inside
  a quoted string* in a multi-line INSERT is data, not a command:
  ```sql
  INSERT INTO movies DOCUMENTS ({'_id':{'id':'repl2','title':'.exit','year':'2026','type':'movie'}});
  ```
  Expect: `OK` — the shell did **not** exit. (Clean up:
  `EVICT FROM movies WHERE _id.id = 'repl2';`)

## 6. Flags refused in REPL mode

- [ ] **`-o/--out`**
  ```bash
  dittosh dql -o /tmp/nope.json ; echo "exit: $?"
  ```
  Expect: `-o/--out is not supported in the interactive REPL`, `exit: 2` —
  the shell never opens.

- [ ] **`--apply` without `-y`**
  ```bash
  dittosh dql --advise --apply ; echo "exit: $?"
  ```
  Expect: `--apply prompts for confirmation — not supported in the REPL
  (use -y, or run one-shot)`, `exit: 2`. (`--advise` alone in the REPL is
  fine.)

## 7. Not a REPL: piped stdin is a batch

- [ ] **Piped input runs as a batch, never opens the shell**
  ```bash
  printf "SELECT count(*) AS n FROM movies;\n" | dittosh dql
  ```
  Expect: the JSON result and the `1 ok, 0 failed (of 1)` summary — no
  prompt. (Dot-command lines here are stripped with a note — see
  `testing-dql-exec.md`.)
