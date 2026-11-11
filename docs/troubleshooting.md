# Troubleshooting and reporting problems

## Check your install

```bash
dittosh doctor            # same as: dittosh dql doctor
```

`doctor` checks the platform, Node version, data directory, license token, that
the Ditto SDK loads and opens a store, and whether another process holds the
store's lock. Each line is `✓` or `✗` with the reason. The exit code says what
failed: `0` all good, `3` a platform, SDK, token, or data-directory problem, `4`
the store is locked by another process.

## Report a problem: `dittosh doctor --report`

```bash
dittosh doctor --report                         # ./dittosh-report-<time>.tar.gz
dittosh doctor --report ~/Desktop/report.tar.gz # choose the file name
dittosh doctor --report -d /path/to/store       # report on a specific store
```

This runs the checks, then writes one `.tar.gz` file to attach to a
[GitHub issue](https://github.com/getditto/ditto-cli/issues/new?template=bug_report.yml).
It extracts into a single folder:

| File | What's in it |
|---|---|
| `report.md` | Readable summary: the sections below. |
| `report.json` | The same data, for tools. |
| `ditto-support-bundle.tar` | Ditto's SDK support bundle (see below). |

`report.md` has these sections:

- **Environment:** dittosh and Ditto SDK versions, release or dev build, how it
  was installed (Homebrew, npm), update status, license expiry, OS version, CPU,
  memory, Node, whether stdout/stderr are terminals and their size, locale and
  time zone.
- **Checks:** every `doctor` check.
- **Paths and disk:** the data directory, store size, free disk space, the config
  directory and the files in it, and the executable path.
- **Settings:** every `DITTOSH_*` variable, plus `NO_COLOR`, `FORCE_COLOR`, `CI`,
  `PAGER`, `LESS`, `TERM`, `TERM_PROGRAM`, `COLORTERM`, `LANG`, `LC_ALL`, and
  `SHELL`. Credential variables (`OFFLINE_TOKEN`, `DATABASE_ID`,
  `DITTOSH_GITHUB_TOKEN`, and any variable whose name contains `TOKEN`, `SECRET`,
  `PASSWORD`, `API_KEY`, `PRIVATE_KEY`, `LICENSE`, `CREDENTIAL`, or `AUTH`) appear only as "set" or "not set", and
  their values are removed from everything else in the report, including the
  saved last error.
- **Store:** collection names with document counts, and index definitions. No
  document contents.
- **Ditto SDK support bundle:** its size and when it was made, or why there isn't
  one.
- **Last error:** the most recent command that failed, with its exit code, the
  last 60 lines it printed to stderr, and a stack trace for unexpected errors.

Options:

| Option | Effect |
|---|---|
| `--report [file]` | Write the bundle (default `./dittosh-report-<time>.tar.gz`). |
| `--no-store` | Leave out the store summary (collection names, counts, indexes). |
| `--no-sdk-bundle` | Leave out the Ditto SDK support bundle. |
| `-d, --data-dir <path>` | The store to check and summarize. |

The report never includes the license token or document contents. In
`report.md` and `report.json` your home folder is written as `~`. The command
line in "Last error" is saved as typed, so a DQL statement with literal values
shows those values.

`ditto-support-bundle.tar` is Ditto's own file, included as is: its config and
logs hold the database ID (which `report.md` shows only as "set"), full file
paths including your home folder, peer keys, and sometimes values from
queries the SDK planned with an index. Leave it out with `--no-sdk-bundle` if
that matters for a public issue.

`--report` never overwrites a file; given a directory, it writes the default
name inside it. Extract the file (`tar -xzf dittosh-report-….tar.gz`) and read
it before you share it.

If the store doesn't exist yet, is locked, or won't open, the report says why
and still includes everything else.

### The last failed command

Whenever a command exits with an error (exit code `1`, `3`, or `4`; not usage
errors), dittosh saves the command, its exit code, and the end of its error
output to `last-error.json` in the config directory. `doctor --report`
includes it, so you can make the report after the fact. Running `doctor` or
`support-bundle` doesn't replace it.

## The Ditto SDK support bundle

Ditto SDK 5.2 can build a support bundle on the device, offline. dittosh asks
for one with `EXECUTE FUNCTION system_request_support_bundle()` and copies it
out. It's a plain `.tar`:

| File | What's in it |
|---|---|
| `ditto-logs.log.gz` | The SDK's debug logs (JSON lines, gzipped). The SDK keeps up to 15 MB / 15 days of logs in the store folder, even when logging is off. |
| `device_logs_METADATA.json` | The time range the logs cover. |
| `config_snapshot.json` | The store configuration with secrets removed, all system parameters, transport settings, and the SDK version. |
| `dial9/dial9.bin.gz` | Runtime telemetry, when available. |
| `bundle_errors.txt` | Present only if part of the bundle failed. |

The SDK bundle isn't redacted by dittosh: the logs and config include the
database ID, full file paths, and peer keys.

To save only this bundle, for example when Ditto support asks for it:

```bash
dittosh dql support-bundle                     # ./ditto-support-bundle-<time>.tar
dittosh dql support-bundle -o bundle.tar
dittosh dql support-bundle --list              # bundles kept in the store
```

Ditto allows **3 new bundles per 10 minutes per store** and keeps the newest 10.
Past the limit, dittosh saves the newest bundle already in the store and says
so. Bundles are stored inside the store, so `--list` shows bundles from earlier
reports too.

## See SDK logs live: `--debug`

```bash
dittosh --debug dql "SELECT * FROM movies LIMIT 1"
DITTOSH_DEBUG=1 dittosh dql "SELECT * FROM movies LIMIT 1"
DITTOSH_DEBUG=verbose dittosh dql …            # even more detail
```

`--debug` (or `DITTOSH_DEBUG=1`) turns on the Ditto SDK's logs at Debug level and
prints a stack trace when a command fails unexpectedly. Everything goes to
stderr, so results on stdout and pipes like `| jq` are unchanged. Save the logs
with `2> debug.log`.

## Common problems

| What you see | What to do |
|---|---|
| `Refusing to load formula getditto/tap/dittosh from untrusted tap` | Newer Homebrew only loads formulas from taps you trust. Run `brew trust getditto/tap`, then install or upgrade again. |
| `dittosh: command not found` | Follow your package manager's shell setup and open a new terminal. |
| Store locked / exit 4 | Close the other dittosh process or shell using the same data directory, or pass `-d` to use another. |
| Expired license | Run `dittosh update`. |
| `platform ✗` | The Ditto SDK supports macOS arm64, Linux x64/arm64, and Windows x64. Intel Macs aren't supported. |
| `node ✗` | Install Node.js 22 or newer. |
| `data directory ✗` | The directory isn't writable or a file is in the way; fix permissions or pass `-d`. |
| WARN/INFO lines when a command starts | The native SDK prints these to stderr at startup; they're harmless and don't affect stdout. |
