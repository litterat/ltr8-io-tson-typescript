/**
 * [TSON-DATA] §8.2's name hygiene at a value whose type is an identifier family, in the JSON
 * encoding ([TSON-JSON] §9.4): a member name keying an identifier-keyed map, and a string at an
 * identifier-typed member, meet the per-name rules, and the keys of such a map, like the elements
 * of a set (or `unique_items` array) of identifiers, are one look-alike scope ([TSON-SCHEMA]
 * §11.4). The same verdicts as text, from the same rules; `identifier-families-read.test.ts` is
 * the text peer.
 *
 * Confusable characters are written as escapes, never literally.
 */
import { describe, expect, it } from 'vitest';

import { isNameRefusal, isVerdict, type Diagnostic } from '../src/core/diagnostic.js';
import { compile } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import {
  DEFAULT_IDENTIFIER_POLICY,
  withSkeletonDistinctness,
  type IdentifierPolicy,
} from '../src/unicode/policy.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

/** `\\u0430dmin`: the first letter is U+0430 CYRILLIC SMALL LETTER A -- a mixed-script name. */
const MIXED = 'аdmin';
/** Cyrillic `раѕѕ`: single-script, and reads alike with Latin `pass`. */
const CYRILLIC_PASS = 'раѕѕ';

const LINKED = resolveUserSchema(`
!!id:"https://example.test/json-names-1.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  identifier => !identifier_type { continue_add: "-" }
  handlers => { identifier => text }
  labels => { text => text }
  route => { name: identifier }
  team => { roles: set<identifier> }
  unique_ids => !array { element_type: identifier  unique_items: true }
  uniq => { roles: unique_ids }
  repeats => { roles: [identifier] }
  words => { roles: set<text> }
  counts => set<int32>
}
`);
const JSON_SCHEMA = compileJsonSchema(LINKED);

function read(
  root: string,
  source: string,
  identifierPolicy: IdentifierPolicy = DEFAULT_IDENTIFIER_POLICY,
): readonly Diagnostic[] {
  return validateJson(source, { schema: JSON_SCHEMA, root, identifierPolicy }).diagnostics;
}

function only(problems: readonly Diagnostic[]): Diagnostic {
  expect(problems.length, JSON.stringify(problems)).toBe(1);
  const first = problems[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

const NO_SKELETON = withSkeletonDistinctness(DEFAULT_IDENTIFIER_POLICY, false);

describe('§8.2, §9.4 an identifier-keyed map’s keys', () => {
  it('a mixed-script key is refused as a name, and the refusal is not a verdict', () => {
    const refused = only(read('handlers', `{"admin": "a", "${MIXED}": "b"}`));
    expect(refused.code).toBe('RESTRICTED_SCRIPT');
    expect(refused.path).toBe(`/${MIXED}`);
    expect(isNameRefusal(refused.code)).toBe(true);
    expect(isVerdict(refused.code)).toBe(false);
  });

  it('two keys that read alike are refused at the second', () => {
    const refused = only(read('handlers', `{"pass": "a", "${CYRILLIC_PASS}": "b"}`));
    expect(refused.code).toBe('CONFUSABLE_NAMES');
    expect(refused.path).toBe(`/${CYRILLIC_PASS}`);
  });

  it('skeleton distinctness is the policy’s to switch off, and the one switch reaches this scope too', () => {
    expect(read('handlers', `{"pass": "a", "${CYRILLIC_PASS}": "b"}`, NO_SKELETON)).toEqual([]);
  });

  it('a text-keyed map is not a scope', () => {
    expect(read('labels', `{"pass": "a", "${CYRILLIC_PASS}": "b", "${MIXED}": "c"}`)).toEqual([]);
  });
});

describe('§8.2, §9.4 an identifier-typed value', () => {
  it('a string at an identifier-typed member is a name', () => {
    const refused = only(read('route', `{"name": "${MIXED}"}`));
    expect(refused.code).toBe('RESTRICTED_SCRIPT');
    expect(refused.path).toBe('/name');
  });
});

describe('§11.4 a set, or a unique array, of identifiers is a look-alike scope', () => {
  it('two set elements that read alike are refused at the second', () => {
    const refused = only(read('team', `{"roles": ["pass", "${CYRILLIC_PASS}"]}`));
    expect(refused.code).toBe('CONFUSABLE_NAMES');
    expect(refused.path).toBe('/roles/1');
    expect(read('team', `{"roles": ["pass", "${CYRILLIC_PASS}"]}`, NO_SKELETON)).toEqual([]);
  });

  it('a unique_items array of identifiers is the same scope', () => {
    expect(only(read('uniq', `{"roles": ["pass", "${CYRILLIC_PASS}"]}`)).code).toBe(
      'CONFUSABLE_NAMES',
    );
  });

  it('an array that allows repeats is not a scope, and neither is a set of text', () => {
    expect(read('repeats', `{"roles": ["pass", "${CYRILLIC_PASS}"]}`)).toEqual([]);
    expect(read('words', `{"roles": ["pass", "${CYRILLIC_PASS}"]}`)).toEqual([]);
  });

  it('an element that fails is reported as itself, whether it failed its form or was refused as a name', () => {
    expect(only(read('counts', '[1, "x", 2]')).code).toBe('TYPE_MISMATCH');
    expect(only(read('team', `{"roles": ["admin", "${MIXED}"]}`)).code).toBe('RESTRICTED_SCRIPT');
  });
});

describe('the same verdicts as text, from the same rules', () => {
  const text = compile(LINKED);
  const textVerdicts = (root: string, body: string): readonly string[] =>
    validateText(new TextEncoder().encode(body), { schema: text, root }).diagnostics.map(
      (d) => `${d.code} ${d.path ?? ''}`,
    );

  it('a confusable pair in a set, a mixed-script key, a mixed-script value', () => {
    expect(textVerdicts('team', `{ roles: [ pass "${CYRILLIC_PASS}" ] }`).length).toBeGreaterThan(
      0,
    );
    expect(read('team', `{"roles": ["pass", "${CYRILLIC_PASS}"]}`).map((d) => d.code)).toEqual(
      validateText(new TextEncoder().encode(`{ roles: [ "pass" "${CYRILLIC_PASS}" ] }`), {
        schema: text,
        root: 'team',
      }).diagnostics.map((d) => d.code),
    );
  });
});
