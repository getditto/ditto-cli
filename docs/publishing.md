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
- Homebrew formula installation, offline DQL, and install-channel detection on
  macOS arm64 and Linux x64/arm64. Before npm publication, a temporary local
  HTTP server supplies the same package bytes to the test formula.
- The formula deletes the Ditto SDK's native binaries for other platforms
  (roughly 270–300 MB, depending on the platform), keeping only the one for the
  installing machine; the smoke test checks that exactly that one remains.
- npm and Homebrew use the same tarball and SHA-256. Direct runtime dependencies
  are pinned to the versions in the build lockfile, including the native SDK.

Homebrew uses a formula, not a macOS-only cask. It manages Node.js 24 and installs
under its own Cellar; `dittosh update` therefore selects `brew upgrade`, while
npm installations select `npm install -g @dittolive/cli@latest`. Intel Macs are
excluded because the current SDK has no darwin-x64 native binary.

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
