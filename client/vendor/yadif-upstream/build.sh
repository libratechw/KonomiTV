#!/usr/bin/env bash
# Rebuild client/vendor/yadif-upstream from the pinned mpeg2toh264 commit.
#
# The bundle is the yadif package's own build output; nothing is patched by
# hand. Run from anywhere; the files land next to this script.
set -euo pipefail

REPO="https://github.com/libratechw/mpeg2toh264.git"
# fix/yadif-runtime-20260919 tip: the three runtime fixes plus the dist commit.
COMMIT="af329929e1c2c47ce60ab22bdfd2519eca33bd7e"

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --filter=blob:none "$REPO" "$WORK/src"
git -C "$WORK/src" checkout --quiet "$COMMIT"
npm --prefix "$WORK/src" install --silent --no-audit --no-fund
npm --prefix "$WORK/src" run build --workspace @mpeg2toh264/yadif

cp "$WORK/src/packages/yadif/dist/index.js" "$HERE/index.js"
cp "$WORK/src/packages/yadif/dist/"*.d.ts "$HERE/"
sha256sum "$HERE/index.js"
echo "wrote $HERE/index.js and its type declarations"