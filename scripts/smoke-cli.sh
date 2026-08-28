#!/usr/bin/env bash
# Drives the *published* CLI the way a consumer gets it: packed into tarballs, installed into a
# throwaway project, and invoked through `node_modules/.bin/tson` -- which npm creates as a symlink.
#
# That last detail is the reason this script exists. Every unit test calls `main(argv)` in-process,
# and running `dist/cli.js` by its own path is the one invocation where `process.argv[1]` equals the
# resolved `import.meta.url`. Through the symlink it does not, and the CLI was a silent no-op that
# exited 0 for every command -- including `validate`, where a script reading `$?` would conclude the
# input was valid. Nothing in the repository could see it, because nothing ran the installed binary.
#
# Run after `npm run build`. Exits non-zero on the first failed expectation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "smoke-cli: FAIL -- $*" >&2; exit 1; }

echo "==> packing"
npm pack --loglevel=warn --workspace @ltr8/tson --workspace @ltr8/tson-cli --pack-destination "$WORK" >/dev/null

echo "==> installing into a throwaway project"
mkdir -p "$WORK/project"
cd "$WORK/project"
echo '{ "name": "smoke", "private": true, "version": "1.0.0", "type": "module" }' > package.json
npm install --no-audit --no-fund --loglevel=error "$WORK"/ltr8-tson-*.tgz "$WORK"/ltr8-tson-cli-*.tgz >/dev/null

TSON="./node_modules/.bin/tson"
[ -L "$TSON" ] || [ -f "$TSON" ] || fail "no bin at $TSON"

# The property the whole script is for: the binary must actually run through its symlink.
echo "==> --help produces output"
out="$("$TSON" --help)" || fail "--help exited non-zero"
[ -n "$out" ] || fail "--help printed nothing: the entry guard did not fire through the bin symlink"
case "$out" in *"Usage:"*) ;; *) fail "--help did not print usage" ;; esac

echo "==> init-example writes real files"
"$TSON" init-example ./demo >/dev/null || fail "init-example exited non-zero"
[ -f ./demo/person.tn ] || fail "init-example wrote no schema"
[ -f ./demo/person-data.tn ] || fail "init-example wrote no data document"

echo "==> validate: exit codes are the contract"
"$TSON" validate ./demo/person-data.tn --schema ./demo/person.tn --root person >/dev/null \
  || fail "a valid document did not exit 0"

printf '{ name: "Ada"  age: 999999  active: true }\n' > ./bad.tn
set +e
"$TSON" validate ./bad.tn --schema ./demo/person.tn --root person >/dev/null 2>&1
invalid=$?
"$TSON" validate --no-such-flag ./demo/person-data.tn >/dev/null 2>&1
usage=$?
"$TSON" no-such-command >/dev/null 2>&1
unknown=$?
set -e
[ "$invalid" -eq 1 ] || fail "invalid data exited $invalid, expected 1"
[ "$usage" -eq 2 ]   || fail "an unrecognized option exited $usage, expected 2"
[ "$unknown" -eq 2 ] || fail "an unknown command exited $unknown, expected 2"

echo "==> hash and compile produce output"
[ -n "$("$TSON" hash ./demo/person.tn)" ] || fail "hash printed nothing"
[ -n "$("$TSON" compile ./demo/person.tn)" ] || fail "compile printed nothing"

echo "==> the library resolves for a consumer, ESM and CJS"
cat > check.mjs <<'JS'
import { readTree } from '@ltr8/tson';
import { sha256Hex } from '@ltr8/tson/identity';
import { standardLibrary } from '@ltr8/tson/stdlib';
if (readTree(new TextEncoder().encode('{ a: 1 }')).kind !== 'record') throw new Error('esm readTree');
if ((await sha256Hex(new TextEncoder().encode('!!id:"x"\nb'))).length !== 64) throw new Error('esm hash');
if (typeof standardLibrary !== 'function') throw new Error('esm stdlib');
JS
cat > check.cjs <<'JS'
const { readTree } = require('@ltr8/tson');
if (readTree(new TextEncoder().encode('{ a: 1 }')).kind !== 'record') throw new Error('cjs readTree');
JS
node check.mjs || fail "ESM import of the published package failed"
node check.cjs || fail "CJS require of the published package failed"

echo "==> zero runtime dependencies"
count="$(node -e "
const l = require('./package-lock.json');
console.log(Object.keys(l.packages).filter((k) => k.startsWith('node_modules/')).length);
")"
[ "$count" -eq 2 ] || fail "installing pulled in $count packages, expected exactly 2 (the two own packages)"

echo "smoke-cli: OK"
