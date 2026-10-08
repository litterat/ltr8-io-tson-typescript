/**
 * [TSON-DATA] §8.2 and [TSON-SCHEMA] §5.5, §11.4 at the schema-directed reads of both encodings: a
 * value of an identifier family is a name wherever it stands, judged under the family's own profile
 * and put into the family's `normalization` form first; the keys of a map keyed by one and the
 * elements of a unique array of one are look-alike scopes.
 *
 * The text reader and the JSON reader are held to the same answers, case by case. Confusable
 * characters are written as escapes and never literally.
 */
import { describe, expect, it } from 'vitest';

import { compile, validate, read } from '../src/compiler/compile.js';
import { isNameRefusal, isVerdict, type Diagnostic } from '../src/core/diagnostic.js';
import { TsonNameHygieneRefusedError } from '../src/core/errors.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { DEFAULT_IDENTIFIER_POLICY, withSkeletonDistinctness } from '../src/unicode/policy.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/identifier-families-read.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  identifier => !identifier_type { continue_add: "-" }
  header_name => !identifier_type { start: NONE  continue: NONE
    start_add: "abcdefghijklmnopqrstuvwxyz"  continue_add: "abcdefghijklmnopqrstuvwxyz0123456789-"
    normalization: NFKC_CASEFOLD }
  field_name => !identifier_type { start: NONE  continue: NONE
    start_add: "abcdefghijklmnopqrstuvwxyz"  continue_add: "abcdefghijklmnopqrstuvwxyz0123456789-"
    normalization: ASCII_CASEFOLD }
  kebab_name => !identifier_type { medial: "-" }

  handlers => { identifier => text }
  roles    => set<identifier>
  path     => [identifier]
  header   => { name: kebab_name }
  headers  => { header_name => text }
  fields   => { field_name => text }
  profile  => { name: identifier }
  defaults => { name?: identifier ~ admin }
}
`;

const LINKED = resolveUserSchema(SCHEMA_SOURCE);
const TEXT = compile(LINKED);
const JSON_SCHEMA = compileJsonSchema(LINKED);

const CYR_A = 'а';
const NKO = 'ߨ';
const CYRILLIC_PASS = 'раѕѕ';

function text(root: string, source: string, relaxed = false): readonly Diagnostic[] {
  const compiled = relaxed
    ? compile(LINKED, {
        identifierPolicy: withSkeletonDistinctness(DEFAULT_IDENTIFIER_POLICY, false),
      })
    : TEXT;
  return validate(compiled, root, new TextEncoder().encode(source)).diagnostics;
}

function json(root: string, source: string, relaxed = false): readonly Diagnostic[] {
  return validateJson(source, {
    schema: JSON_SCHEMA,
    root,
    identifierPolicy: relaxed
      ? withSkeletonDistinctness(DEFAULT_IDENTIFIER_POLICY, false)
      : DEFAULT_IDENTIFIER_POLICY,
  }).diagnostics;
}

/** The codes reported, in order. */
const codes = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.code);

describe.each([
  ['text', text],
  ['JSON', json],
] as const)('identifier families, %s reader', (_encoding, run) => {
  const doc = (textForm: string, jsonForm: string): string => (run === text ? textForm : jsonForm);

  it('a key that mixes scripts inside one word is refused by the restriction level alone (§8.2)', () => {
    const diagnostics = run('handlers', doc(`{ ${CYR_A}dmin => a }`, `{"${CYR_A}dmin":"a"}`));
    expect(codes(diagnostics)).toEqual(['RESTRICTED_SCRIPT']);
    expect(diagnostics.some((d) => isVerdict(d.code) && !isNameRefusal(d.code))).toBe(false);
  });

  it('two keys that read alike are one scope: refused at the second (§11.4)', () => {
    const diagnostics = run(
      'handlers',
      doc(`{ pass => a  ${CYRILLIC_PASS} => b }`, `{"pass":"a","${CYRILLIC_PASS}":"b"}`),
    );
    expect(codes(diagnostics)).toEqual(['CONFUSABLE_NAMES']);
    expect(diagnostics[0]?.path).toBe(`/${CYRILLIC_PASS}`);
  });

  it('skeleton distinctness is relaxable by a code decision, and nothing else changes', () => {
    expect(
      codes(
        run(
          'handlers',
          doc(`{ pass => a  ${CYRILLIC_PASS} => b }`, `{"pass":"a","${CYRILLIC_PASS}":"b"}`),
          true,
        ),
      ),
    ).toEqual([]);
  });

  it('a key that failed to read is no name of the scope: a refused key is not also a look-alike', () => {
    const diagnostics = run(
      'handlers',
      doc(
        `{ pass => a  p${CYR_A}ss => b  ${CYRILLIC_PASS} => c }`,
        `{"pass":"a","p${CYR_A}ss":"b","${CYRILLIC_PASS}":"c"}`,
      ),
    );
    // `pаss` mixes scripts (refused) and is left out of the scope; `раѕѕ` still reads alike with `pass`.
    expect(codes(diagnostics)).toEqual(['RESTRICTED_SCRIPT', 'CONFUSABLE_NAMES']);
  });

  it('the elements of a set of names are one scope, and a refused element is in no check (§11.4)', () => {
    expect(
      codes(run('roles', doc(`[ pass ${CYRILLIC_PASS} ]`, `["pass","${CYRILLIC_PASS}"]`))),
    ).toEqual(['CONFUSABLE_NAMES']);
    expect(codes(run('roles', doc(`[ admin ${CYR_A}dmin ]`, `["admin","${CYR_A}dmin"]`)))).toEqual([
      'RESTRICTED_SCRIPT',
    ]);
  });

  it('an array that admits repetition is not a scope', () => {
    expect(
      codes(run('path', doc(`[ pass ${CYRILLIC_PASS} ]`, `["pass","${CYRILLIC_PASS}"]`))),
    ).toEqual([]);
  });

  it('a field value of an identifier family meets the per-name mechanisms as a key does', () => {
    expect(codes(run('profile', doc(`{ name: ${CYR_A}dmin }`, `{"name":"${CYR_A}dmin"}`)))).toEqual(
      ['RESTRICTED_SCRIPT'],
    );
  });

  it('reports every rule a name fails, the restricted-character rule first', () => {
    expect(
      codes(run('profile', doc(`{ name: ${CYR_A}dmin${NKO} }`, `{"name":"${CYR_A}dmin${NKO}"}`))),
    ).toEqual(['RESTRICTED_CHARACTER', 'RESTRICTED_SCRIPT']);
  });

  it('a token outside the profile’s grammar is a form failure, never a policy refusal (§7.7)', () => {
    const diagnostics = run('profile', doc('{ name: "2fast" }', '{"name":"2fast"}'));
    expect(codes(diagnostics)).toEqual(['ATOM_FORM_INVALID']);
  });

  it('a profile whose `-` is medial refuses a name that ends with it (§5.5)', () => {
    expect(codes(run('header', doc('{ name: content-type }', '{"name":"content-type"}')))).toEqual(
      [],
    );
    expect(codes(run('header', doc('{ name: content- }', '{"name":"content-"}')))).toEqual([
      'ATOM_FORM_INVALID',
    ]);
  });

  it('keys are put into the family’s form: two casings of one name are one key (§2.6, §5.5)', () => {
    const diagnostics = run(
      'headers',
      doc('{ Content-Type => a  content-type => b }', '{"Content-Type":"a","content-type":"b"}'),
    );
    expect(codes(diagnostics)).toEqual(['DUPLICATE_MAP_KEY']);
  });

  it('NFKC_CASEFOLD folds a full-width spelling into the same key; ASCII_CASEFOLD leaves it alone', () => {
    expect(
      codes(
        run(
          'headers',
          doc(
            '{ content-type => a  "\\u{FF23}ontent-\\u{FF34}ype" => b }',
            '{"content-type":"a","Ｃontent-Ｔype":"b"}',
          ),
        ),
      ),
    ).toEqual(['DUPLICATE_MAP_KEY']);
    expect(
      codes(run('fields', doc('{ "\\u{FF23}ontent-Type" => a }', '{"Ｃontent-Type":"a"}'))),
    ).toEqual(['ATOM_FORM_INVALID']);
    expect(
      codes(run('fields', doc('{ "\\u{212A}eep-Alive" => a }', '{"Keep-Alive":"a"}'))),
    ).toEqual(['ATOM_FORM_INVALID']);
    expect(
      codes(
        run(
          'fields',
          doc(
            '{ Content-Type => a  content-type => b }',
            '{"Content-Type":"a","content-type":"b"}',
          ),
        ),
      ),
    ).toEqual(['DUPLICATE_MAP_KEY']);
  });
});

describe('a refusal under a fail-fast text read (§8.2)', () => {
  it('is TsonNameHygieneRefusedError, never one of §8.1’s categories', () => {
    let thrown: unknown;
    try {
      read(TEXT, 'profile', new TextEncoder().encode(`{ name: ${CYR_A}dmin }`));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsonNameHygieneRefusedError);
    expect((thrown as TsonNameHygieneRefusedError).mechanism).toBe('restriction-level');
  });
});
