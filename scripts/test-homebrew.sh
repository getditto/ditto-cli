#!/usr/bin/env bash
# Prove the Homebrew formula works before tagging a release: a real
# `brew install` of the release package on this Mac, and in Linux arm64 and
# x64 containers (Docker; x64 is emulated on Apple Silicon, so it takes longer).
#
#   scripts/test-homebrew.sh              # macOS (if on a Mac) + Linux arm64 + Linux x64
#   scripts/test-homebrew.sh mac          # only this Mac
#   scripts/test-homebrew.sh linux        # only the Linux containers
#   scripts/test-homebrew.sh mac --keep   # leave the Mac's Homebrew install to try by hand
#
# Needs .env dev credentials (to stamp the release token). Nothing is published;
# the macOS test removes its temporary tap and install when done, unless --keep
# is given and every check passed.
set -euo pipefail
cd "$(dirname "$0")/.." # repo root

usage() {
  echo "Usage: scripts/test-homebrew.sh [all|mac|linux] [--keep]" >&2
  exit 2
}
targets=all
keep=()
for arg in "$@"; do
  case "$arg" in
    all | mac | linux) targets="$arg" ;;
    --keep) keep=(--keep) ;;
    *) usage ;;
  esac
done
if [[ ${#keep[@]} -gt 0 && ("$targets" == linux || "$(uname -s)" != Darwin) ]]; then
  echo "--keep applies to the Mac check only (Linux containers are always removed)." >&2
  exit 2
fi
version="$(node -p 'require("./package.json").version')"
tag="v$version"

# The release package and formula, exactly as the release job builds them.
node --env-file=.env --import tsx scripts/release.ts build "$tag"

if [[ "$targets" != linux && "$(uname -s)" == Darwin ]]; then
  existing="$(brew --prefix)/bin/dittosh"
  if [[ -e "$existing" || -L "$existing" ]]; then
    echo "$existing already exists, so Homebrew can't link the test install." >&2
    echo "Remove it first: npm uninstall -g @dittolive/cli, or for a kept test install" >&2
    echo "  brew uninstall --formula getditto/release-smoke/dittosh && brew untap getditto/release-smoke," >&2
    echo "then reinstall afterwards with scripts/install-release.sh." >&2
    exit 1
  fi
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
    node --import tsx scripts/release-smoke.ts homebrew "$tag" ${keep[@]+"${keep[@]}"}
fi

if [[ "$targets" != mac ]]; then
  # Under the repo, not /tmp: colima and Docker Desktop share the home folder.
  work="build/homebrew-linux"
  rm -rf "$work"
  mkdir -p "$work"
  cp "build/release/dittolive-cli-$version.tgz" scripts/homebrew-linux-check.sh "$work/"
  sed "s|^  url \".*\"|  url \"file:///release/dittolive-cli-$version.tgz\"|" \
    build/release/dittosh.rb >"$work/dittosh.rb"
  # On an ARM host, x64 runs under QEMU. QEMU_CPU=max gives it SSSE3 and newer
  # instructions, but /proc/cpuinfo still describes the ARM host, and Homebrew
  # refuses to run on x64 unless it lists ssse3; mount a stand-in that does.
  printf 'processor\t: 0\nmodel name\t: QEMU emulated x86_64\nflags\t\t: fpu sse sse2 ssse3 sse4_1 sse4_2 popcnt avx avx2 cx16 lahf_lm\n\n' \
    >"$work/cpuinfo-x64"
  for platform in linux/arm64 linux/amd64; do
    echo "== Homebrew on $platform"
    emulate=()
    if [[ "$platform" == linux/amd64 && "$(uname -m)" =~ ^(arm64|aarch64)$ ]]; then
      emulate=(-e QEMU_CPU=max -v "$PWD/$work/cpuinfo-x64:/proc/cpuinfo:ro")
    fi
    # ${a[@]+...}: an empty array trips `set -u` in macOS's bash 3.2.
    docker run --rm --platform "$platform" ${emulate[@]+"${emulate[@]}"} -v "$PWD/$work:/release:ro" \
      homebrew/brew:latest bash /release/homebrew-linux-check.sh
  done
fi
echo "Homebrew formula checks passed for $tag"
