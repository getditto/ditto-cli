import type { InstallChannel } from "../update/channel.js";

/**
 * The hands-on tutorial behind `dittosh tutorial`, as structured content:
 * prose blocks plus code blocks that know whether they can run unattended.
 * The renderer turns it into Markdown; tests/e2e/tutorial.test.ts runs every
 * runnable bash block in order against a fresh store, so a tutorial command
 * that stops working fails CI instead of confusing a reader.
 */

export interface TutorialContext {
  cliVersion: string;
  sdkVersion: string;
  channel: InstallChannel;
  /** `${process.platform}/${process.arch}` */
  platform: string;
  /** YYYY-MM-DD */
  generatedOn: string;
}

export type Block =
  | { kind: "text"; md: string }
  | {
      kind: "code";
      lang: "bash" | "sql" | "text";
      code: string;
      /** false: needs a TTY, the network, a package manager, or an optional tool. */
      run: boolean;
      /** Strings the block's stdout must contain when run by the tutorial test. */
      expect?: string[];
    };

export interface Section {
  title: string;
  blocks: Block[];
}

/** Shell parameter expansion, kept out of a JS template placeholder. */
const TMPDIR_DEFAULT = ["$", "{TMPDIR:-/tmp}"].join("");

const text = (md: string): Block => ({ kind: "text", md: md.trim() });

/** A bash block the tutorial test executes (shared shell state across blocks). */
const sh = (code: string, expect?: string[]): Block => ({
  kind: "code",
  lang: "bash",
  code: code.trim(),
  run: true,
  ...(expect ? { expect } : {}),
});

/** A bash block shown to the reader but not executed by the tutorial test. */
const shManual = (code: string): Block => ({
  kind: "code",
  lang: "bash",
  code: code.trim(),
  run: false,
});

const listing = (lang: "sql" | "text", code: string): Block => ({
  kind: "code",
  lang,
  code: code.trim(),
  run: false,
});

function upgradeCommand(channel: InstallChannel): string {
  return channel === "npm"
    ? "npm install -g @dittolive/cli@latest"
    : "brew update && brew upgrade getditto/tap/dittosh";
}

function channelName(channel: InstallChannel): string {
  return channel === "homebrew" ? "Homebrew" : channel === "npm" ? "npm" : "an unknown method";
}

export function tutorialSections(ctx: TutorialContext): Section[] {
  const windows = ctx.platform.startsWith("win32");
  return [
    {
      title: "Check your installation",
      blocks: [
        sh(
          `
dittosh --version
dittosh version
dittosh --help
`,
          [ctx.cliVersion],
        ),
        text(`
\`dittosh --version\` prints the CLI version. \`dittosh version\` also reports the
Ditto SDK version, installation channel, license expiry, and data-directory path.
This copy reports **${ctx.cliVersion}** with Ditto SDK **${ctx.sdkVersion}**, installed
through **${channelName(ctx.channel)}**.

The executable is **\`dittosh\`**, not the macOS \`ditto\` utility. To set it up on
another machine, use either package manager:
`),
        shManual(`
# Homebrew (Apple Silicon macOS, Linux x64/arm64)
brew install getditto/tap/dittosh

# npm (Node.js 22 or newer; also Windows x64)
npm install -g @dittolive/cli
`),
        text(`
Intel Macs are not supported by the native SDK bundled with this release.
${windows ? "\nThe commands in this tutorial use Bash syntax. On Windows, run them in WSL or Git Bash.\n" : ""}`),
      ],
    },
    {
      title: "Create an isolated practice workspace",
      blocks: [
        sh(`
DITTOSH_TUTORIAL="$(mktemp -d "${TMPDIR_DEFAULT}/dittosh-tutorial.XXXXXX")"
cd "$DITTOSH_TUTORIAL"
export DITTOSH_DATA_DIR="$DITTOSH_TUTORIAL/store"
export DITTOSH_CONFIG_DIR="$DITTOSH_TUTORIAL/config"
printf 'Practice directory: %s\\n' "$DITTOSH_TUTORIAL"
dittosh dql doctor
`),
        text(`
Keep this terminal open for the rest of the tutorial. \`doctor\` checks the native
SDK, offline license, directory access, and whether the store can be opened.
Save the printed directory path if you want to revisit your practice files.

You may see native SDK startup messages on stderr. Query results are written to
stdout separately, which lets you pipe them into other tools.
`),
      ],
    },
    {
      title: "Import a product catalog",
      blocks: [
        text("Create a JSON array of documents:"),
        sh(
          `
cat > products.json <<'JSON'
[
  {"_id":"p1","name":"Coffee beans","category":"coffee","price":12.5,"stock":20},
  {"_id":"p2","name":"Paper filters","category":"coffee","price":5,"stock":100},
  {"_id":"p3","name":"Green tea","category":"tea","price":9,"stock":30}
]
JSON

dittosh dql import products.json products
dittosh dql collections
dittosh dql "SELECT count(*) AS total FROM products"
`,
          ['"total": 3'],
        ),
        text(`
**Check:** the \`products\` collection contains **3 documents**.

Imports also accept NDJSON: one JSON object per line. Supplying stable \`_id\`
values makes re-imports update the matching documents. Without \`_id\`, the importer
generates IDs, so importing the same file again creates additional documents.
`),
      ],
    },
    {
      title: "Query, filter, sort, and bind parameters",
      blocks: [
        text("Show a few fields, ordered by price:"),
        sh(`dittosh dql "SELECT name, category, price, stock FROM products ORDER BY price DESC"`),
        text("Filter with named parameters:"),
        sh(
          String.raw`
dittosh dql "SELECT name, price FROM products WHERE category = :category AND price >= :minimum ORDER BY price DESC" \
  --param category=coffee --param minimum=10
`,
          ["Coffee beans", "12.5"],
        ),
        text(`
**Check:** the filtered query returns **Coffee beans**, priced at **12.5**.
Parameter values are interpreted as JSON when possible, with a string fallback.
You can pass the parameters as a JSON object instead:
`),
        sh(
          String.raw`
dittosh dql "SELECT name, price FROM products WHERE category = :category AND price >= :minimum" \
  --args '{"category":"coffee","minimum":10}'
`,
          ["Coffee beans"],
        ),
        text("Use `LIMIT` to keep exploratory queries small:"),
        sh(`dittosh dql "SELECT * FROM products LIMIT 2" --format vertical`),
        text("`vertical` displays one record at a time and is useful for wide documents."),
      ],
    },
    {
      title: "Insert, update, and remove a practice document",
      blocks: [
        text("Insert a mug. The conflict clause makes repeating this INSERT safe for the same ID:"),
        sh(`
dittosh dql "INSERT INTO products VALUES ({'_id':'p4','name':'Mug','category':'accessories','price':8,'stock':15}) ON ID CONFLICT DO UPDATE"
dittosh dql "SELECT name, stock FROM products WHERE _id = 'p4'"
`),
        text("Update its stock, then query it again:"),
        sh(
          `
dittosh dql "UPDATE products SET stock = 12 WHERE _id = 'p4'"
dittosh dql "SELECT name, stock FROM products WHERE _id = 'p4'"
`,
          ['"stock": 12'],
        ),
        text(
          "**Check:** Mug now has **12** units in stock.\n\nRemove that practice document from the local store:",
        ),
        sh(
          `
dittosh dql "EVICT FROM products WHERE _id = 'p4'"
dittosh dql "SELECT count(*) AS total FROM products"
`,
          ['"total": 3'],
        ),
        text(`
**Check:** the count is back to **3**. \`EVICT\` removes local data; it is distinct
from a synchronized deletion. This CLI's database is offline-only.
`),
      ],
    },
    {
      title: "Run a file of statements",
      blocks: [
        sh(`
cat > report.dql <<'DQL'
SELECT count(*) AS total FROM products;
SELECT name, price FROM products WHERE category = 'coffee' ORDER BY price DESC;
DQL

dittosh dql --file report.dql --time
`),
        text(`
Separate statements with semicolons. By default, a batch stops at its first
error. Add \`--continue-on-error\` when you intentionally want later statements
to run even if an earlier one fails.

You can also feed a statement through stdin:
`),
        sh(String.raw`printf 'SELECT count(*) AS total FROM products;\n' | dittosh dql`, [
          '"total": 3',
        ]),
      ],
    },
    {
      title: "Export results and use pipes",
      blocks: [
        text("The output filename determines the format for these exports:"),
        sh(`
dittosh dql "SELECT name, price, stock FROM products ORDER BY name" --out products-report.csv
dittosh dql "SELECT name, price, stock FROM products ORDER BY name" --out products-report.json
dittosh dql "SELECT name, price, stock FROM products ORDER BY name" --out products-report.md
dittosh dql "SELECT name, price, stock FROM products ORDER BY name" --out products-report.html
`),
        text(`
These files are written into your practice directory. Open the HTML file in a
browser or include the Markdown table in a document.

For explicit terminal formats:
`),
        sh(`
dittosh dql "SELECT name, price FROM products" --format json
dittosh dql "SELECT name, price FROM products" --format markdown
`),
        text("**Optional: JSON pipelines with `jq`.** Install `jq` first if needed:"),
        shManual(`
dittosh dql "SELECT name, price FROM products ORDER BY price DESC" | jq '.[0].name'
`),
        text(`
**Check:** the pipeline prints \`"Coffee beans"\`. When stdout is piped, the default
query output is JSON. Progress and diagnostics stay on stderr.
`),
      ],
    },
    {
      title: "Use the interactive DQL shell",
      blocks: [
        text("From your terminal, start the shell:"),
        shManual("dittosh dql"),
        text("At the `dql>` prompt, enter:"),
        listing(
          "sql",
          `
SELECT name, price FROM products ORDER BY price DESC;
SELECT count(*) AS total FROM products;
`,
        ),
        text(`
Finish each DQL statement with \`;\`. You can split a statement across lines.
Try these dot-commands **inside the interactive shell**:
`),
        listing(
          "text",
          `
.help
.collections
.indexes products
.metrics
`,
        ),
        text(`
\`.metrics\` shows the Ditto SDK's live system metrics for this session as tables:

- **Store:** SQLite transactions, fsync, write-ahead log size, and commit and lock
  timings.
- **Query (DQL):** requests, selects, failures, and parse, plan, and execution times.

Totals and averages run since the shell opened. The **Change**, **p50/p90/p99**,
and **Max** columns cover only the time since your previous \`.metrics\`, so run a
few statements and then \`.metrics\` again to see what they cost. \`.metrics query\`
narrows the view; \`.metrics all\` adds network, sync, transport, and other sections.
`),
        listing(
          "text",
          `
.metrics query
.exit
`,
        ),
        text(`
Use \`.break\` to discard an unfinished statement. \`.exit\` returns you to your
normal terminal. The remaining examples are normal terminal commands.
`),
      ],
    },
    {
      title: "Explore built-in sample datasets",
      blocks: [
        sh(
          `
dittosh dql dataset list
dittosh dql dataset show movies
dittosh dql dataset load movies --docs 1000 --seed 42
dittosh dql "SELECT count(*) AS total FROM movies"
`,
          ['"total": 1000'],
        ),
        text(`
**Check:** the \`movies\` collection has **1,000 documents** in this fresh workspace.
The movies dataset uses a structured \`_id\`: its title and year are accessed as
\`_id.title\` and \`_id.year\`, and its year is stored as a string.
`),
        sh(`
dittosh dql "SELECT _id.title, _id.year, rated FROM movies WHERE _id.year > '2000' LIMIT 5"
dittosh dql dataset run count --dataset movies
`),
        text(`
\`dataset run\` executes a named example from the dataset's query catalog. Use
\`dataset show\` to see available names. \`--seed\` makes data generation repeatable;
use the same seed for repeatable experiments.

The available datasets include \`movies\`, \`retail\`, \`retail-joins\`, and \`pos\`.
The retail datasets share collection names, so use separate stores when comparing
them or when you already have a collection named \`products\`.
`),
      ],
    },
    {
      title: "Inspect timing, plans, and profiles",
      blocks: [
        sh(
          `
dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG' LIMIT 5" --time
dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG' LIMIT 5" --explain
dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG' LIMIT 5" --profile --time
`,
        ),
        text(`
- \`--time\` reports execution timing.
- \`--explain\` shows the query plan.
- \`--profile\` runs the query with \`PROFILE\` and shows the operator tree. Each
  operator lists its CPU time (with its share of the total) and documents in, out,
  and skipped. Dim lines underneath show:
  - \`recv\`: time spent waiting for input from upstream
  - \`send\`: time spent pushing output downstream
  - \`stor\`: time blocked on storage
  - **yields**: how often the operator paused for the scheduler, by reason
    (\`budget\`, \`sender\`, \`receiver\`, \`heartbeat\`)
  - the operator's attributes

  Any operator using at least half the CPU time is flagged \`▲ HOT\`.

Compare the plans before and after adding an index in the next section. Timing
varies by hardware and data size; a tiny dataset may not show a measurable speedup.
`),
      ],
    },
    {
      title: "Ask for index advice",
      blocks: [
        text("First inspect the advice without changing the store:"),
        sh(`dittosh dql --advise "SELECT * FROM movies WHERE rated = 'PG'"`),
        text("Then apply the suggested index to this practice database:"),
        sh(
          `
dittosh dql --advise --apply --yes "SELECT * FROM movies WHERE rated = 'PG'"
dittosh dql indexes movies
dittosh dql "SELECT _id.title FROM movies WHERE rated = 'PG' LIMIT 5" --explain
`,
          ["rated"],
        ),
        text(`
**Check:** an index on \`rated\` should appear in the index list. Compare the new
plan with the earlier one. \`--yes\` confirms the schema change without prompting.
`),
      ],
    },
    {
      title: "Benchmark a query",
      blocks: [
        text(`
One timing can mislead: the first run of a query pays for cold caches and query
planning. \`dql bench\` runs a statement many times and reports the spread.
`),
        sh(
          `dittosh dql bench "SELECT _id.title FROM movies WHERE rated = 'PG'" --runs 20 --warmup --format json`,
          ['"p95_ms"'],
        ),
        text(`
- \`--runs <n>\` sets how many timed runs to make (default 50).
- \`--warmup\` runs the statement untimed first, enough times to fill about 250 ms.
  \`--warmup 5\` runs exactly 5 warmup runs. Leave it out for no warmup.
- With more than one run you get the mean, **p50** (the median), **p95**, **p99**,
  min, max, and standard deviation, in milliseconds. p95 means 95% of runs were at
  least this fast.

Progress goes to stderr and the results to stdout, so \`--format json\`, \`-o\`, and
pipes work as they do for queries.

**Set up and clean up around the timing.** \`--pre\` runs a statement once before
timing and \`--post\` runs one once afterwards, even if something failed. Use them to
measure a query with an index, then remove it so the store is back where it started:
`),
        sh(`
dittosh dql bench "SELECT * FROM movies WHERE _id.year = '1999'" --runs 20 \\
  --pre "CREATE INDEX IF NOT EXISTS movies_year ON movies (_id.year)" \\
  --post "DROP INDEX IF EXISTS movies_year ON movies"
`),
        text(`
Run it again without \`--pre\` and \`--post\` to compare against a full scan.

**Restore state between runs.** A write changes the data, so the second run of the
same \`EVICT\` would find nothing to remove. \`--pre\` runs only once, so it can't help
here: \`--before-each\` runs a statement before every run, untimed, to put the data back:
`),
        sh(`
dittosh dql bench "EVICT FROM movies WHERE _id = 'bench-doc'" --runs 10 \\
  --before-each "INSERT INTO movies VALUES ({'_id': 'bench-doc', 'rated': 'TEST'})"
`),
        text(`
Each run inserts \`bench-doc\` (untimed) and then evicts it (timed), so every run
measures a real eviction, and the store ends as it started.

To time an insert instead, undo it after every run with \`--after-each\` (also
untimed), so the next run can insert the same document again. The \`--pre\` evict
clears a \`bench-doc\` left over from an interrupted run, and the \`--post\` evict
removes it if a run fails before its undo:
`),
        sh(`
dittosh dql bench "INSERT INTO movies VALUES ({'_id': 'bench-doc', 'rated': 'TEST'})" --runs 10 \\
  --pre "EVICT FROM movies WHERE _id = 'bench-doc'" \\
  --after-each "EVICT FROM movies WHERE _id = 'bench-doc'" \\
  --post "EVICT FROM movies WHERE _id = 'bench-doc'"
`),
        text(`
\`--pre\`, \`--before-each\` (also spelled \`--reset\`), \`--after-each\`, and
\`--post\` can each be repeated, and \`--before-each\` and \`--after-each\` can be
used together.

**Keep benchmarks in a file.** A benchmark file is JSON: an object whose keys name
the benchmarks. Each benchmark has a \`query\` (the statement that is timed) and,
optionally, \`preQueries\`, \`resetQueries\`, \`afterEachQueries\`, and \`postQueries\`
(lists of statements, the file versions of \`--pre\`, \`--before-each\`,
\`--after-each\`, and \`--post\`) and a \`description\`.
They run in this order:

1. \`preQueries\` once
2. warmup runs, each preceded by \`resetQueries\` and followed by \`afterEachQueries\`
3. the timed runs, each preceded by \`resetQueries\` and followed by
   \`afterEachQueries\` (both untimed)
4. \`postQueries\` once, even after a failure

The fastest way to start is a sample file built from a sample dataset. It includes
a plain read, an indexed read, and a write that restores its own data, each with a
description of what its parts do:
`),
        sh(
          `
dittosh dql bench --example movies -o movies-bench.json
dittosh dql bench -f movies-bench.json --runs 10 --warmup 2
`,
          ["filtered_query_with_index"],
        ),
        text(`
Open \`movies-bench.json\` to see the format, then copy an entry and change it to
time your own statements. \`--only <name>,<name>\` runs some of a file's benchmarks,
and \`dataset run <query> --runs <n> --warmup\` benchmarks a single catalog query.
The other samples are \`--example retail\`, \`retail-joins\`, and \`pos\`; load that
dataset first. Timings depend on your hardware and data size, so compare runs made
on the same machine with the same data.
`),
      ],
    },
    {
      title: "Try a JOIN in a separate store",
      blocks: [
        text(
          "Use a separate directory so the retail dataset does not mix with your product catalog:",
        ),
        sh(
          String.raw`
dittosh dql dataset load retail-joins --docs 50 --seed 42 \
  --data-dir "$DITTOSH_TUTORIAL/joins-store"

dittosh dql --data-dir "$DITTOSH_TUTORIAL/joins-store" \
  "SELECT o._id, o.total, s.store_name, s.location.city
   FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id
   WHERE o._id = 'order_20221209_0001'"
`,
          ["Zava Retail Seattle", "164.25"],
        ),
        text(`
**Check:** the anchor order joins to **Zava Retail Seattle**, with a total of
**164.25**. A command's \`--data-dir\` overrides the environment variable only for
that command; the next command without it uses your original practice store.

Profile the same join to see how Ditto runs it. A nested-loop join (\`nlJoin\`)
shows the lookup it repeats for every outer row as a labeled \`inner:\` subtree:
`),
        sh(
          String.raw`
dittosh dql --data-dir "$DITTOSH_TUTORIAL/joins-store" --profile \
  "SELECT o._id, o.total, s.store_name
   FROM orders AS o INNER JOIN stores AS s ON o.store_id = s._id
   WHERE o._id = 'order_20221209_0001'"
`,
        ),
      ],
    },
    {
      title: "Diagnostics and advanced DQL",
      blocks: [
        text(`
These examples cover the system collections you can use for diagnostics, and some
more advanced DQL, using the \`products\` collection from section 3.

**Sync health:** \`system:sync_degradations\` lists documents that cannot sync, such as
documents that are too large. This offline CLI never syncs, so it is always empty
here, but the same query works in your apps:
`),
        sh(`dittosh dql "SELECT count(*) AS degraded FROM system:sync_degradations"`, [
          '"degraded": 0',
        ]),
        text(`
**Support bundles:** one statement captures a diagnostic bundle, stored as an
attachment, and \`system:support_bundles\` lists the bundles on this device:
`),
        sh(
          `
dittosh dql "EXECUTE FUNCTION system_request_support_bundle()"
dittosh dql "SELECT _id.created_at AS created, reason, file.len AS bytes FROM system:support_bundles"
`,
          ["USER_INITIATED"],
        ),
        text(`
**Storage facts:** \`system:system_info\` reports write-ahead-log size and checkpoint
pressure for the SQLite storage engine:
`),
        sh(
          `dittosh dql "SELECT DISTINCT key FROM system:system_info WHERE namespace = 'backend_sqlite3' ORDER BY key"`,
          ["wal_current_size_bytes"],
        ),
        text(`
**Query metrics:** query-engine counters use \`ditto.query.*\` names. Values cover the
current process, so a one-shot command only counts itself — the interactive shell's
\`.metrics\` shows them grow.
`),
        sh(
          `dittosh dql "SELECT key, current, unit FROM system:metrics WHERE key LIKE 'ditto.query.%' ORDER BY key"`,
          ["ditto.query.requests"],
        ),
        text(`
**Conditions on array elements:** \`ANY … SATISFIES\` tests the elements of an array
one at a time; with \`AND\`, both conditions must hold for the same element. Create
two orders and find the one with a line for 2 × p1:
`),
        sh(
          `
dittosh dql "INSERT INTO orders VALUES ({'_id':'o1','lines':[{'sku':'p1','qty':2},{'sku':'p2','qty':1}]}), ({'_id':'o2','lines':[{'sku':'p1','qty':1},{'sku':'p3','qty':5}]}) ON ID CONFLICT DO UPDATE"
dittosh dql "SELECT _id FROM orders WHERE ANY l IN lines SATISFIES l.sku = 'p1' AND l.qty = 2 END"
`,
          ['"o1"'],
        ),
        text("**Check:** only **o1** matches. o2 also contains p1, but with quantity 1."),
        text(`
**Addressing documents by ID:** \`USE IDS\` targets documents by \`_id\` without a
WHERE clause. Evict p2, confirm it's gone, then restore it:
`),
        sh(
          `
dittosh dql "EVICT FROM products USE IDS 'p2'"
dittosh dql "SELECT count(*) AS total FROM products"
dittosh dql "INSERT INTO products VALUES ({'_id':'p2','name':'Paper filters','category':'coffee','price':5,'stock':100}) ON ID CONFLICT DO UPDATE"
`,
          ['"total": 2'],
        ),
        text(`
**Comparisons written constant-first:** with an index on \`price\`, \`6 < price\` reads
the same index range as \`price > 6\`. Run it with \`--explain\` and look for \`"low"\` in
the index range:
`),
        sh(
          `
dittosh dql "CREATE INDEX IF NOT EXISTS idx_price ON products (price)"
dittosh dql "SELECT name, price FROM products WHERE 6 < price ORDER BY price"
dittosh dql "SELECT _id FROM products WHERE 6 < price" --explain
`,
          ["Green tea", "Coffee beans"],
        ),
        text(`
**Indexes that mix sort directions:** a composite index on
\`(category ASC, price DESC)\` returns the most expensive product first within each
category:
`),
        sh(
          `
dittosh dql "CREATE INDEX IF NOT EXISTS idx_cat_price ON products (category ASC, price DESC)"
dittosh dql "SELECT name, category, price FROM products ORDER BY category ASC, price DESC"
`,
        ),
        text(`
**Check:** Coffee beans (12.5) is listed before Paper filters (5). The interactive
lessons (next section) cover these features step by step.
`),
      ],
    },
    {
      title: "Learn DQL interactively",
      blocks: [
        text(`
For a guided introduction to DQL itself, start the interactive lessons. They run in
their own practice store, explain each concept (what a projection is, how
functions and aggregation work, why indexes help), give you a task, and check your
answer:
`),
        shManual(`
dittosh tutorial --interactive
dittosh tutorial --interactive --level intermediate
`),
        text(`
Lessons are grouped as **beginner** (queries, filtering, projection, sorting,
writes), **intermediate** (expressions, functions, \`CASE\`, MISSING vs NULL,
aggregation, grouping), and **advanced** (joins, \`ANY … SATISFIES\`, indexes, query
plans, profiling, system collections). The lessons open full screen (add
\`--plain\` for a simple line-by-line shell). Type a statement and press Enter to run it
(a trailing \`;\` is optional); a \`|\` prompt means it looks unfinished, so keep
typing or use \`.break\`. Tab or \`.hint\` nudges you, \`?\` explains the keys,
\`.answer\` shows a solution, \`.lessons\` lists your progress, and \`.exit\` saves it.
`),
      ],
    },
    {
      title: "Install skills for an AI coding tool",
      blocks: [
        text(`
Skills are downloaded from the public
[Ditto agent-skills repository](https://github.com/getditto/agent-skills).
They do not require installation through an agent marketplace. The CLI installs
instruction files; it does not install or launch the AI tool itself.

Create a practice project and inspect available skill releases:
`),
        shManual(`
mkdir -p "$DITTOSH_TUTORIAL/agent-project"
dittosh skills versions
`),
        text(`
Choose the command for your tool. Each example installs the latest skills release
into this practice project, rather than your global agent configuration:
`),
        shManual(`
# Claude Code: DQL guidance
dittosh skills add write-dql --agent claude --project "$DITTOSH_TUTORIAL/agent-project"

# Codex: Swift SDK guidance
dittosh skills add swift-sdk --agent codex --project "$DITTOSH_TUTORIAL/agent-project"

# Antigravity: Kotlin SDK guidance
dittosh skills add kotlin-sdk --agent antigravity --project "$DITTOSH_TUTORIAL/agent-project"

# Claude Code: JavaScript and TypeScript guidance (Node.js, web, React Native, Expo)
dittosh skills add js-sdk --agent claude --project "$DITTOSH_TUTORIAL/agent-project"
`),
        text(`
Some skills link to other skills, and those links only work when both are
installed. \`dittosh skills add\` installs the linked skills too and lists them.
For example, \`js-sdk\` brings the Node.js, web, React Native, and Expo skills
and \`native-app-config\`. Add \`--no-deps\` to install only the named skill.
`),
        text("Check what was installed:"),
        shManual(`dittosh skills list --project "$DITTOSH_TUTORIAL/agent-project"`),
        text(`
For these examples, expect project directories under \`.claude/skills\`,
\`.codex/skills\`, or \`.agents/skills\` respectively. Open the practice project in
your chosen AI tool and start a fresh session so it can discover the new files.
For example, ask: “Use the Ditto DQL skill to explain how to query documents by
category with a named parameter.” Actual skill loading depends on the AI tool.

Other CLI targets include \`opencode\`, \`gemini\`, \`cursor\`, \`copilot\`, and
\`windsurf\`. The last three require project-local installation. To install into
your real project, replace the practice-project path with that project's path.
`),
      ],
    },
    {
      title: "Install more skills, pin versions, and update them",
      blocks: [
        text(`
**Optional:** install every skill for Claude Code in the practice project, pinned to
one release. Pick a tag from \`dittosh skills versions\`:
`),
        shManual(`
dittosh skills add --all --agent claude \\
  --project "$DITTOSH_TUTORIAL/agent-project" --ref <tag>
`),
        text(`
\`add\` skips existing installations by default. \`--force\` overwrites them. Use
\`update\` when you want installed skills to move to a newer release:
`),
        shManual(`
dittosh skills update --all --project "$DITTOSH_TUTORIAL/agent-project"
dittosh skills list --project "$DITTOSH_TUTORIAL/agent-project"
`),
        text(`
Without \`--ref\`, updates select the latest available skills release. If everything
already matches, the update is a no-op. Omitting \`--all\` targets the default DQL
skill unless you specify another skill by name.

**The versions are independent:** \`dittosh\` **${ctx.cliVersion}** is the CLI; the
agent-skills bundle has its own release tags. Updating skills does not upgrade
the CLI, and upgrading the CLI does not automatically update skills.
`),
      ],
    },
    {
      title: "Report a problem",
      blocks: [
        text(`
When something goes wrong, \`dittosh doctor\` checks the platform, Node, the data
directory, the license, the SDK, and the store lock. Add \`--report\` to save
everything a maintainer needs into one file you can attach to a GitHub issue:
`),
        sh(
          `
dittosh doctor
dittosh doctor --report "$DITTOSH_TUTORIAL/dittosh-report.tar.gz"
tar -tzf "$DITTOSH_TUTORIAL/dittosh-report.tar.gz"
`,
          ["report.md", "ditto-support-bundle.tar"],
        ),
        text(`
The bundle holds:

- \`report.md\` (and the same data as \`report.json\`): versions, OS and terminal
  details, the checks, paths and free space, and dittosh settings. Credentials
  appear only as "set" or "not set", and your home folder shows as \`~\`.
- A store summary: collection names, document counts, and indexes, with no
  document contents. Leave it out with \`--no-store\`.
- The last failed command and the error it printed. dittosh saves this
  whenever a command fails, so you can make the report after the fact.
- \`ditto-support-bundle.tar\`: Ditto's own support bundle, with the SDK's debug
  logs and the store configuration, included as is. It holds the database ID,
  full file paths, and peer keys. Leave it out with \`--no-sdk-bundle\`, or save
  just this part with \`dittosh dql support-bundle\`.

Extract the file and read it before you share it. To watch the SDK's logs
while you reproduce a problem, add \`--debug\` to any command; the logs go to
stderr, so results on stdout are unchanged.
`),
      ],
    },
    {
      title: "Update the CLI and clean up",
      blocks: [
        text(
          `Check for a newer release and upgrade through ${channelName(ctx.channel) === "an unknown method" ? "your package manager" : channelName(ctx.channel)}:`,
        ),
        shManual(`
dittosh update --check
dittosh update
dittosh --version
`),
        text(`
\`dittosh update\` detects how the CLI was installed and runs the matching upgrade.
${
  ctx.channel === "unknown"
    ? "This copy could not tell how it was installed, so upgrade manually with `brew update && brew upgrade getditto/tap/dittosh` or `npm install -g @dittolive/cli@latest`."
    : `The equivalent manual command for this installation is \`${upgradeCommand(ctx.channel)}\`.`
}

**Optional cleanup:** first exit any interactive DQL session. The following
commands permanently remove only the two database directories created in this
tutorial; they leave exported files and installed project skills in place:
`),
        sh(`
dittosh dql delete-store --data-dir "$DITTOSH_TUTORIAL/store" --yes
dittosh dql delete-store --data-dir "$DITTOSH_TUTORIAL/joins-store" --yes
unset DITTOSH_DATA_DIR DITTOSH_CONFIG_DIR
`),
        text(`
To remove the remaining practice files, delete the printed practice directory
using your file manager when you no longer need it. Do not use \`delete-store\`
without confirming which data directory it targets.
`),
      ],
    },
  ];
}

const TROUBLESHOOTING = `
| What you see | What to do |
| --- | --- |
| \`dittosh: command not found\` | Follow your package manager's shell setup instructions and open a new terminal. |
| Formula not found | Run \`brew update\`, then use the fully qualified name \`getditto/tap/dittosh\`. |
| Store locked / exit 4 | Close another CLI process or REPL using the same directory, or choose a different \`--data-dir\`. |
| Expired offline license | Run \`dittosh update\`. If the latest release also fails, report it to the CLI maintainers. |
| Empty query results | Check the collection name and data directory; movie titles use \`_id.title\`, not \`title\`. |
| \`.metrics\` says metrics are disabled | Restart the shell; metrics are enabled when the store opens. |
| Agent skills are not discovered | Confirm the project path, inspect \`skills list\`, and start a fresh session in that AI tool. |
| Startup warnings alongside results | Native SDK startup messages go to stderr; use stdout for JSON pipelines. |
| Anything else | Run \`dittosh doctor --report\` and attach the file to a GitHub issue. |
`;

/** Render the tutorial as Markdown. */
export function renderTutorial(ctx: TutorialContext): string {
  const sections = tutorialSections(ctx);
  const out: string[] = [];
  out.push("# Ditto CLI: a hands-on tutorial", "");
  out.push(
    `**Release:** \`dittosh\` ${ctx.cliVersion} (Ditto SDK ${ctx.sdkVersion}) · **Time:** about 35 minutes · **Shell:** Bash or Zsh`,
    "",
  );
  out.push(
    `
Use the Ditto CLI to explore an offline database, run DQL, import and export
documents, investigate query performance, watch live system metrics, and install
skills for AI coding tools. This walkthrough uses a separate practice directory,
so its database exercises do not change your existing Ditto data.

The CLI runs DQL locally with an embedded offline license. You do not need a Ditto
account, database credentials, or a running server. This release does not connect
to a cloud database or synchronize with other devices. Internet access is needed
for installation, upgrades, and downloading agent skills.
`.trim(),
    "",
  );
  out.push("## What you will try", "");
  sections.forEach((s, i) => {
    out.push(`${i + 1}. ${s.title}`);
  });
  out.push(
    "",
    "Run the numbered sections in order in the same terminal. Optional examples are",
    "marked. Commands shown inside the interactive shell are DQL, not shell commands.",
    "",
  );

  sections.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`, "");
    for (const b of s.blocks) {
      if (b.kind === "text") {
        if (b.md) out.push(b.md, "");
      } else {
        out.push(`\`\`\`${b.lang}`, b.code, "```", "");
      }
    }
  });

  out.push("## Quick troubleshooting", "", TROUBLESHOOTING.trim(), "");
  out.push(
    "For a bug report, include the failing command, `dittosh version`, your OS and",
    "architecture, and the error output. Leave out credentials and private documents.",
    "",
  );
  out.push(
    "## Useful links",
    "",
    "- [CLI source and issues](https://github.com/getditto/ditto-cli)",
    `- [CLI ${ctx.cliVersion} release](https://github.com/getditto/ditto-cli/releases/tag/v${ctx.cliVersion})`,
    "- [Homebrew tap](https://github.com/getditto/homebrew-tap)",
    "- [Ditto agent skills](https://github.com/getditto/agent-skills)",
    "- [DQL documentation](https://docs.ditto.live/dql/dql)",
    "",
  );
  out.push(
    `_Generated by \`dittosh tutorial\` on ${ctx.generatedOn} for ${ctx.platform} (installed through ${channelName(ctx.channel)})._`,
    "",
  );
  return out.join("\n");
}
