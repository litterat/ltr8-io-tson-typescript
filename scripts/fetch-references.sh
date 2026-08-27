#!/usr/bin/env bash
#
# Fetch the two public reference repositories the TypeScript port is written against
# into the gitignored .references/ directory.
#
#   ltr8-io-tson-java        pinned to JAVA_PIN so the port target cannot move underneath us
#   ltr8-io-tson-test-suite  tracks main; it is the shared conformance suite
#
# Idempotent: re-running fetches only what changed. Pass --force to re-clone from scratch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF_DIR="$REPO_ROOT/.references"

JAVA_REPO="https://github.com/litterat/ltr8-io-tson-java"
JAVA_PIN="fb93c89fc27ec32d85b899c5d281dbcbf42e2951"
SUITE_REPO="https://github.com/litterat/ltr8-io-tson-test-suite"
SUITE_REF="main"

if [ "${1:-}" = "--force" ]; then
  echo "==> --force: removing $REF_DIR"
  rm -rf "$REF_DIR"
fi

mkdir -p "$REF_DIR"

# fetch_pinned <dir> <url> <committish>
# Shallow-fetches exactly one commit into a checkout at <dir>.
fetch_pinned() {
  local dir="$1" url="$2" ref="$3"
  local path="$REF_DIR/$dir"

  if [ ! -d "$path/.git" ]; then
    echo "==> cloning $dir"
    rm -rf "$path"
    git init --quiet "$path"
    git -C "$path" remote add origin "$url"
  fi

  local head
  head="$(git -C "$path" rev-parse --verify --quiet HEAD || true)"
  if [ -n "$head" ] && [ "$head" = "$(git -C "$path" rev-parse --verify --quiet "$ref^{commit}" || true)" ]; then
    echo "==> $dir already at $ref"
    return
  fi

  echo "==> fetching $dir @ $ref"
  git -C "$path" fetch --depth 1 --quiet origin "$ref"
  git -C "$path" checkout --quiet --detach FETCH_HEAD
  echo "    $dir -> $(git -C "$path" rev-parse --short HEAD)"
}

fetch_pinned ltr8-io-tson-java       "$JAVA_REPO"  "$JAVA_PIN"
fetch_pinned ltr8-io-tson-test-suite "$SUITE_REPO" "$SUITE_REF"

echo
echo "References ready in .references/"
