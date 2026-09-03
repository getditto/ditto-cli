#!/usr/bin/env bash
# Build a release bundle and install it globally as `dittosh` for local testing.
#
#   scripts/install-release.sh
#
# Steps: stamp the obfuscated token from .env → RELEASE=true build → npm i -g .
# Release builds ignore .env credentials, so the installed binary runs anywhere.
set -euo pipefail
cd "$(dirname "$0")/.." # repo root

npm run stamp:token        # build/token-chunks.ts from .env (gitignored)
RELEASE=true npm run build # release bundle → dist/cli.js
npm install -g .           # global @dittolive/cli → `dittosh` on PATH

echo
echo "Installed: $(command -v dittosh)"
dittosh version
