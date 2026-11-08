# Publishing dittosh

Pushing `vX.Y.Z` runs `.github/workflows/release.yml`. The workflow tests one
stamped npm package, publishes it to npm and GitHub, and updates the Homebrew
formula for a stable release. No npm or Homebrew publishing occurs on a branch
push or pull request.

## Initial setup

The CLI package is `@dittolive/cli`; its version is independent of the agent
skills bundle. The CLI consumes skill releases from `getditto/agent-skills`.

Configure these in the CLI repository before creating its first release tag:

| Setting | Purpose |
| --- | --- |
| `DQL_OFFLINE_LICENSE` repository secret | Dedicated CLI offline license, with at least 45 days remaining. |
| `DITTO_DATABASE_ID` repository secret | The app ID issued for that license. |
| `NPM_TOKEN` secret in the `npm` environment | Scoped npm publishing token for the initial publication, or when token authentication is required. May be removed after trusted publishing is configured. |
| `HOMEBREW_TAP_TOKEN` repository secret | Fine-grained token with Contents read/write access to the public Homebrew tap only; used by the preflight access check and the final tap update. |
| `HOMEBREW_TAP_REPOSITORY` repository variable | Optional override; defaults to `getditto/homebrew-tap`. |

Create the GitHub environments `npm` and `homebrew`. Limit their deployment
refs to release tags. The tap needs an initialized default branch; the workflow
creates or updates `Formula/dittosh.rb` after successful publication. Its token
must be allowed to write that file under the tap's branch rules.

For npm trusted publishing, configure `@dittolive/cli` on npmjs.com with:

- Organization: `getditto`
- Repository: `ditto-cli`
- Workflow: `release.yml`
- Environment: `npm`
- Permission to publish directly with `npm publish`

The workflow uses GitHub-hosted runners, `id-token: write`, and a pinned npm
version with OIDC support. npm requires an existing package to configure its
publisher, so the first publication can use `NPM_TOKEN`. The fallback writes a
temporary npmrc outside the package tree and deletes it afterwards. The package
includes the public repository metadata needed for provenance.

## Prepare a release

1. Start a release branch from main. Update `package.json` and `package-lock.json`
   together with `npm version X.Y.Z --no-git-tag-version`.
2. Add `releases/vX.Y.Z.md`, starting with `# dittosh vX.Y.Z`. Write user-facing
   changes, compatibility notes, and installation/update instructions. This
   file is mandatory and becomes the GitHub release body verbatim.
3. Run `npm run release:check`, lint, typecheck, and the tests. The packaging
   check uses an intentionally invalid fixture license and never publishes.
   If the formula or how it installs changed, also run
   `npm run release:homebrew` ([Test the formula locally](#test-the-formula-locally)):
   the release workflow only installs the formula after the tag is pushed.
4. Merge the reviewed release branch and check CI on main.
5. Tag that reviewed commit and push the tag:

```bash
git tag -a vX.Y.Z -m "dittosh vX.Y.Z"
git push origin vX.Y.Z
```

The workflow rejects tag/package/lock mismatches, missing notes, and commits
outside main's history. It does not change versions or create tags for you.

`releases/v0.1.0.md` describes the initial CLI release; update it with any
additional features merged before that tag is created.

## What the workflow verifies

- Release stamping with the CLI's existing token expiry guard. The package is
  checked for the raw token, and no development credentials are used at runtime.
- Exact artifact installation and offline DQL on macOS arm64, Linux x64,
  Linux arm64, and Windows x64 through npm.
- Homebrew formula installation, offline DQL, install-channel detection, and
  that only the machine's own SDK binary is left, on macOS arm64 and Linux
  x64/arm64. Before npm publication, a temporary local HTTP server supplies the
  same package bytes to the test formula. See
  [The Homebrew formula](#the-homebrew-formula).
- npm and Homebrew use the same tarball and SHA-256. Direct runtime dependencies
  are pinned to the versions in the build lockfile, including the native SDK.

## The Homebrew formula

`scripts/release.ts` (`formula()`) generates `Formula/dittosh.rb` from the
exact npm tarball and its SHA-256. The release workflow publishes it to the tap,
and attaches it to the GitHub release.

Homebrew uses a formula, not a macOS-only cask, so the same formula serves macOS
and Linux. It depends on `node@24` and installs under its own Cellar;
`dittosh update` therefore selects `brew upgrade`, while npm installations
select `npm install -g @dittolive/cli@latest`. Intel Macs are excluded
(`depends_on arch: :arm64` on macOS) because the SDK has no darwin-x64 binary.
The tap builds no bottles: `brew install` runs `install` on the user's own
machine every time.

### What `install` does

1. `npm install` of the release tarball into the keg's `libexec`, the standard
   Homebrew way to install a Node CLI (`std_npm_args`).
2. **Remove other platforms' SDK binaries.** `@dittolive/ditto` is one npm
   package that ships a native binary for every platform it supports, so npm
   installs all of them:

   | File | Size |
   | --- | --- |
   | `node/ditto.darwin-arm64.node` | 88 MB |
   | `node/ditto.linux-x64.node` | 112 MB |
   | `node/ditto.linux-arm64.node` | 107 MB |
   | `node/ditto.win32-x64.node` | 76 MB |
   | `web/` (WebAssembly build, not used by dittosh) | 37 MB |

   The SDK loads `ditto.<process.platform>-<process.arch>.node` and nothing
   else. The formula works out the same name from Homebrew's own checks
   (`OS.mac?` → `darwin` or `linux`, `Hardware::CPU.arm?` → `arm64` or `x64`),
   keeps that file, and deletes the other three: roughly 270–300 MB, depending
   on the platform. Installs end up around 150 MB on macOS and 180 MB on Linux,
   instead of about 420 MB.
   - If the expected file isn't there (an unsupported machine, or a future SDK
     that lays its files out differently), nothing is deleted, so the install
     still behaves exactly as npm left it.
   - `web/` is kept on purpose, in case dittosh uses the WebAssembly build later.
   - npm installs are unchanged and still include every platform. Fixing that
     needs per-platform SDK packages (for example `@dittolive/ditto-darwin-arm64`
     as optional dependencies), which only the SDK can publish.
3. A `dittosh` wrapper in `bin` that puts Homebrew's Node.js 24 first on `PATH`.

The formula's `test do` block checks `--version` and runs an offline
`INSERT`/`SELECT`, which proves the kept binary loads.

### How it's tested

| Where | When | What |
| --- | --- | --- |
| `tests/unit/release.test.ts` | every CI run | The formula text, and its pruning code run with plain `ruby` against a fake install for macOS arm64, Linux x64, Linux arm64, and an unsupported machine (Homebrew's OS/CPU checks are stubbed). Skipped where `ruby` isn't installed. |
| `npm run release:homebrew` | locally, before tagging | A real `brew install` of the release package on your Mac and in Linux arm64 and x64 containers. See below. |
| Release workflow (`homebrew-install`) | after a tag is pushed, before publishing | A real `brew install`, `brew test`, offline DQL, install-channel detection, and the one-binary check (`scripts/release-smoke.ts homebrew`) on `macos-15`, `ubuntu-24.04`, and `ubuntu-24.04-arm`. Publishing waits for it. |

### Test the formula locally

```bash
npm run release:homebrew                   # this Mac + Linux arm64 + Linux x64
scripts/test-homebrew.sh mac               # only this Mac
scripts/test-homebrew.sh linux             # only the Linux containers
scripts/test-homebrew.sh mac --keep        # this Mac, and leave the install to try by hand
```

It needs the `.env` dev credentials (to stamp the release token), Homebrew on a
Mac, and Docker for Linux (colima or Docker Desktop). Nothing is published.

Step by step, on a Mac:

1. Start Docker (for example `colima start`), unless you only run `mac`.
2. Remove your own `dittosh`, unless you only run `linux`; Homebrew can't link
   the test install over it:
   ```bash
   npm uninstall -g @dittolive/cli
   ```
3. Run the checks: `npm run release:homebrew` (several minutes, mostly the
   emulated x64 container), or `scripts/test-homebrew.sh mac` / `linux` for
   one part.
4. Read the result. A pass ends with `Homebrew formula checks passed for
   vX.Y.Z`, after a `PASS linux-arm64: …` and a `PASS linux-x64: …` line with
   the installed size. A failure stops the run, with a `FAIL:` line or an
   error saying what was wrong.
5. Put your `dittosh` back: `scripts/install-release.sh`.

To try the Homebrew-installed `dittosh` yourself, run step 3 as
`scripts/test-homebrew.sh mac --keep`. After every check passes, it leaves the
install and its tap in place and prints how to remove them. `dittosh version`
then shows `channel  homebrew (/opt/homebrew)`. When you're done:

```bash
brew uninstall --formula getditto/release-smoke/dittosh && brew untap getditto/release-smoke
scripts/install-release.sh   # your usual dittosh again
```

`--keep` applies only to the Mac check; a failed run is always cleaned up. The
kept formula points at the test's local server, which has stopped, so
`brew reinstall` of it won't work; run the script again instead.

The script builds the release package and formula exactly as the release job
does (`scripts/release.ts build`, into `build/release`), then:

- **This Mac:** runs `scripts/release-smoke.ts homebrew`. It serves the package
  from a local HTTP server, adds a temporary tap (`getditto/release-smoke`),
  runs `brew install` and `brew test`, checks offline DQL, that `dittosh`
  reports the `homebrew` install channel, and that only
  `ditto.darwin-arm64.node` is left. It then uninstalls and removes the tap
  (unless `--keep`).
- **Linux arm64 and x64:** copies the package, the formula (pointed at a
  `file://` URL), and `scripts/homebrew-linux-check.sh` to
  `build/homebrew-linux`, and runs that check in a throwaway `homebrew/brew`
  container for each platform. It updates Homebrew, installs and tests the
  formula, and fails unless only `ditto.linux-<arch>.node` remains, `web/` is
  intact, offline DQL works, and `dittosh` reports the `homebrew` channel.

A passing run ends with `Homebrew formula checks passed for vX.Y.Z`, after a
`PASS linux-arm64: …` and a `PASS linux-x64: …` line with the installed size.

Things to know:

- **Remove your own `dittosh` first** for the Mac check: if
  `$(brew --prefix)/bin/dittosh` exists (an npm or Homebrew install), Homebrew
  can't link the test install, and the script stops and says so. Remove it with
  `npm uninstall -g @dittolive/cli` (or, for a kept test install, the
  `brew uninstall`/`brew untap` commands above) and reinstall afterwards with
  `scripts/install-release.sh`. The `linux` mode doesn't need this.
- **It can upgrade your Homebrew packages.** Installing the formula installs or
  upgrades `node@24` and its dependencies on your Mac if they're outdated.
- **Linux x64 is emulated on Apple Silicon**, so it takes several minutes. The
  emulator (QEMU) runs with `QEMU_CPU=max` so x64 code has the instructions it
  needs, but `/proc/cpuinfo` inside the container still describes the ARM host,
  and Homebrew refuses to run on x64 unless it lists `ssse3`. The script mounts
  a stand-in `/proc/cpuinfo` for that container only. The formula and the SDK
  binary run for real, but on emulated hardware; the release workflow's
  `ubuntu-24.04` job is the real-x64 check.
- **Files are staged under the repo** (`build/homebrew-linux`, gitignored), not
  in `/tmp`: colima and Docker Desktop share only your home folder with
  containers.
- **The container runs `brew update` first**, because the image's Homebrew can
  be too old to install current bottles (it fails with
  `undefined method '[]' for nil`).
- Docker settings aren't changed; the containers are removed when they finish.

## Stable releases, prereleases, and retries

- Stable versions advance npm `latest`, publish a GitHub release, and update the
  Homebrew stable formula. An older stable version uses npm `previous` and never
  downgrades the tap or GitHub's latest release.
- Versions such as `v0.2.0-rc.1` use npm `next`, create a GitHub prerelease, and
  do not update the Homebrew stable formula.
- GitHub assets are the npm `.tgz`, `SHA256SUMS`, and the generated `dittosh.rb`.
  The GitHub release stays a draft until all assets are uploaded.
- If npm succeeded but GitHub or Homebrew failed, rerun the workflow for the
  same tag. It restores the npm tarball, verifies its integrity and `gitHead`,
  retests those immutable bytes, and resumes the remaining publication steps.
  It never overwrites an npm version or moves a release tag.
- If the tap update fails, the npm and GitHub releases remain usable; the workflow
  reports failure. Fix tap access and rerun. GitHub release creation does not
  need to be repeated manually.

For a complete test without publishing, dispatch the workflow for an existing
tag with `dry-run` enabled (the default). This still needs the real CLI license
to verify DQL. For recovery, disable `dry-run`; use the exact original tag.
Both dry runs and publishing runs must run from the selected tag. Every job
checks out the triggering commit; there is no separate ref input. This also
satisfies the tag-only environment policy:

```bash
gh workflow run Release --repo getditto/ditto-cli --ref vX.Y.Z \
  -F dry-run=false
```

## Verify the published release

```bash
gh run list --repo getditto/ditto-cli --workflow release.yml --limit 1
gh release view vX.Y.Z --repo getditto/ditto-cli
npm view @dittolive/cli@X.Y.Z version dist.integrity
npm install -g @dittolive/cli@X.Y.Z
dittosh version
dittosh dql doctor
brew install getditto/tap/dittosh
brew test getditto/tap/dittosh
```

Use separate test environments for npm and Homebrew installations to avoid
putting two `dittosh` commands on the same PATH. Normal updates are:

```bash
npm install -g @dittolive/cli@latest
# Homebrew installations:
brew update && brew upgrade dittosh
```

## What was reused from the SDK release system

The SDK's [JS publishing job](https://github.com/getditto/ditto/blob/3779375e02a69dc5663d4d29328053a465103826/.github/workflows/sdk-release.yml)
gates npm publication on validated builds. Its
[JS release task](https://github.com/getditto/ditto/blob/3779375e02a69dc5663d4d29328053a465103826/sdks/js/jake/release.cjs)
handles existing versions and avoids promoting older/prerelease versions to
`latest`. Its
[React Native tools publisher](https://github.com/getditto/ditto/blob/3779375e02a69dc5663d4d29328053a465103826/scripts/ci/sdk_release/react-native/publish_reactnativedittotools.sh)
requires reviewed versioned notes and keeps npm authentication in a temporary
file outside the build tree. The CLI adapts these patterns, adding byte-integrity
checks for retries and requiring `releases/<tag>.md` as requested.

The private monorepo's composite setup action configures its AWS release role;
it is not a standalone npm publisher. Calling it from the public CLI would
require private-repository access and additional AWS trust configuration.
The CLI instead uses npm OIDC or its own scoped bootstrap token. The SDK's
moving-tag helper deletes and recreates tags, so it is deliberately not reused
for immutable CLI versions.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[Homebrew Node formula guidance](https://docs.brew.sh/Language-Specific-Formulae#nodejs),
and [Homebrew taps](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap).
