#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# Prepares a remote session to work on the TSON TypeScript port:
#   1. puts Node 24+ on PATH (the image defaults to Node 22; package.json requires >=24)
#   2. fetches the pinned reference checkouts into .references/
#   3. installs workspace dependencies once a package.json exists
#
# Idempotent and non-interactive.

set -euo pipefail

# Local machines are already set up the way their owner wants them.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR"

# --- 1. Node 24 -------------------------------------------------------------
# The port targets Node 24+. This image ships several Node builds under /opt and
# defaults PATH to node22, so select the first /opt/nodeNN that satisfies the
# floor rather than hard-coding one version.
REQUIRED_MAJOR=24

current_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$(current_major)" -lt "$REQUIRED_MAJOR" ]; then
  for candidate in $(ls -d /opt/node* 2>/dev/null | sort -Vr); do
    [ -x "$candidate/bin/node" ] || continue
    candidate_major="$("$candidate/bin/node" -p 'process.versions.node.split(".")[0]')"
    if [ "$candidate_major" -ge "$REQUIRED_MAJOR" ]; then
      export PATH="$candidate/bin:$PATH"
      if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        echo "export PATH=\"$candidate/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
      fi
      echo "session-start: selected Node $("$candidate/bin/node" --version) from $candidate"
      break
    fi
  done
fi

if [ "$(current_major)" -lt "$REQUIRED_MAJOR" ]; then
  echo "session-start: WARNING no Node >=$REQUIRED_MAJOR found; using $(node --version 2>/dev/null || echo none)" >&2
fi

# --- 2. Reference checkouts -------------------------------------------------
# The conformance harness and every port work package read from .references/.
# It is gitignored, so a fresh container starts without it.
if [ -x ./scripts/fetch-references.sh ]; then
  ./scripts/fetch-references.sh || echo "session-start: WARNING reference fetch failed; conformance tests will skip" >&2
fi

# --- 3. Workspace dependencies ---------------------------------------------
# No-op until the scaffold lands a package.json. npm install (not ci) so the
# cached container layer is reused across sessions.
if [ -f package.json ]; then
  npm install --no-fund --no-audit
fi

echo "session-start: ready"
