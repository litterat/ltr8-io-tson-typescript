#!/usr/bin/env bash
#
# Fetch the two public reference repositories the TypeScript port is written against
# into the gitignored .references/ directory.
#
#   ltr8-io-tson-java        pinned to JAVA_PIN so the port target cannot move underneath us
#   ltr8-io-tson-test-suite  pinned to SUITE_PIN, the shared conformance corpus
#
# Both are pinned to a commit, never a branch. Tracking the suite's main meant any vector added
# or reshaped upstream turned this repo's CI red with no change here -- and the corpus migration
# ahead would break every consumer at once. Bumping a pin is a deliberate commit.
#
# Idempotent: re-running fetches only what changed. Pass --force to re-clone from scratch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF_DIR="$REPO_ROOT/.references"

JAVA_REPO="https://github.com/litterat/ltr8-io-tson-java"
JAVA_PIN="0c1512c766a70792b409db3e5f6a717ae68ebd15"
SUITE_REPO="https://github.com/litterat/ltr8-io-tson-test-suite"
# 328 subjects over tests/<class>/<layer>/<bucket>/, with RUNNER.md normative for runners. The
# 2026 Revision 36 baseline: three-slot fields, record extension and the =? selector, type_ref
# supertypes, the record-bodied template as a family base, declared applications as entries,
# and enum profiles.
SUITE_PIN="f9fa96f09f5e74dc45b40ceca48fa6dd8115464d"

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
fetch_pinned ltr8-io-tson-test-suite "$SUITE_REPO" "$SUITE_PIN"

echo
echo "References ready in .references/"
