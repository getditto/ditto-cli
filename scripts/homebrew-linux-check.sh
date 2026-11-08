#!/usr/bin/env bash
# Runs inside a homebrew/brew container (started by scripts/test-homebrew.sh):
# installs the release formula from /release with Homebrew, then checks that
# only this platform's Ditto SDK binary is left and that offline DQL works.
set -euo pipefail
export HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

case "$(uname -m)" in
  aarch64) want=linux-arm64 ;;
  x86_64) want=linux-x64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

# The image's Homebrew can be too old to pour today's bottles.
brew update --quiet >/dev/null 2>&1 || brew update
export HOMEBREW_NO_AUTO_UPDATE=1
echo "== $want, $(brew --version | head -1)"

brew tap-new --no-git local/smoke >/dev/null 2>&1
cp /release/dittosh.rb "$(brew --repository local/smoke)/Formula/dittosh.rb"
brew install --formula local/smoke/dittosh
brew test local/smoke/dittosh

prefix="$(brew --prefix local/smoke/dittosh)"
kept="$(find -L "$prefix/libexec" -name 'ditto.*.node' -printf '%f\n' | sort | tr '\n' ' ')"
[[ "$kept" == "ditto.$want.node " ]] || fail "expected only ditto.$want.node, found: $kept"
sdk="$prefix/libexec/lib/node_modules/@dittolive/cli/node_modules/@dittolive/ditto"
[[ -d "$sdk/web" ]] || fail "the SDK's web/ folder was removed"

store="$(mktemp -d)"
"$prefix/bin/dittosh" dql -d "$store" "INSERT INTO t DOCUMENTS ({'_id': 'ok', 'n': 1})" >/dev/null 2>&1
"$prefix/bin/dittosh" dql -d "$store" "SELECT n FROM t LIMIT 1" 2>/dev/null | grep -q '"n": 1' ||
  fail "offline DQL did not return the inserted document"
"$prefix/bin/dittosh" version --format json 2>/dev/null | grep -q '"channel": "homebrew' ||
  fail "dittosh did not detect the Homebrew install"

echo "PASS $want: kept ditto.$want.node, web/ intact, offline DQL ok, $(du -sh "$(brew --cellar)/dittosh" | cut -f1) installed"
