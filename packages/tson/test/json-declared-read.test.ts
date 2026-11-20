/**
 * [TSON-JSON] §8.5's declared positions, the open sum over the governing closure, read end to
 * end: the value names its own type in an annotation object led by `$type`, and a value naming no
 * type is refused. The cases the Java reference states in `JsonDeclaredReadTest` (the bind-mode
 * ones excepted, there being no bind door in this package), restated against the spec sections
 * that require them. The TSON-text peer is `json-cross-encoding-parity.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const COMPILED = compileJsonSchema(
  resolveUserSchema(`
!!id:"https://example.test/json-declared-host.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  note     => { body: text }
  memo     => { body: text  urgent: boolean }
  count    => !integer ^ { min: 0  max: 9 }
  envelope => { local: meta.declared }
  inbox    => { items: [meta.declared] }
}
`),
);

function problems(rootType: string, json: string): readonly Diagnostic[] {
  return validateJson(json, { schema: COMPILED, root: rootType }).diagnostics;
}

function refusal(rootType: string, json: string): Diagnostic {
  const found = problems(rootType, json);
  expect(found.length, JSON.stringify(found)).toBe(1);
  const first = found[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

const envelope = (local: string): string => `{"local": ${local}}`;

describe('§8.5 a declared position takes any type the governing schema holds', () => {
  it('the choice of which type is the data’s', () => {
    for (const local of [
      '{"$type": "note", "body": "hi"}',
      '{"$type": "memo", "body": "hi", "urgent": true}',
    ]) {
      const result = validateJson(envelope(local), { schema: COMPILED, root: 'envelope' });
      expect(result.diagnostics).toEqual([]);
      expect(result.value === undefined ? '' : jsonValueToText(result.value)).toMatch(
        /^\{"local":\{"body":"hi"/,
      );
    }
  });

  it('§3.3: a value of any shape rides in the wrapper form -- an atom from the governing schema, here', () => {
    expect(problems('envelope', envelope('{"$type": "count", "$value": 7}'))).toEqual([]);
    expect(problems('envelope', envelope('{"$type": "int32", "$value": -1}'))).toEqual([]);
  });

  it('the selected type validates in full: its facets hold inside the wrapper', () => {
    const found = refusal('envelope', envelope('{"$type": "count", "$value": 10}'));
    expect(found.path?.startsWith('/local')).toBe(true);
  });

  it('each element of [meta.declared] names its own type', () => {
    expect(
      problems(
        'inbox',
        '{"items": [{"$type": "note", "body": "a"}, {"$type": "memo", "body": "b", "urgent": false}]}',
      ),
    ).toEqual([]);
  });
});

describe('§8.5 a declared position refuses a value that names no type', () => {
  it('a name the governing schema does not hold is an unresolved reference', () => {
    const found = refusal('envelope', envelope('{"$type": "claim", "id": "a", "amount": 1}'));
    expect(found.code).toBe('UNKNOWN_TYPE');
    expect(found.path).toBe('/local');
  });

  it('a bare value is a validation error in every shape -- there is no permissive reading', () => {
    for (const bare of ['"hi"', '3', 'true', '[1, 2]', '{"body": "hi"}']) {
      const found = refusal('envelope', envelope(bare));
      expect(found.code, bare).toBe('VALIDATION_ERROR');
      expect(found.path, bare).toBe('/local');
    }
  });

  it('an annotation object without $type names no type either', () => {
    expect(refusal('envelope', envelope('{"$value": 1}')).code).toBe('VALIDATION_ERROR');
  });
});

describe('§3.3, §8.5 $import at a declared position', () => {
  it('is a resolver error, as at every value position: a value cannot widen the namespace it is read in', () => {
    const found = refusal(
      'envelope',
      envelope('{"$import": ["https://example.test/other.tn"], "$type": "note", "body": "hi"}'),
    );
    expect(found.code).toBe('SCOPE_NOT_ADMITTED');
    expect(found.path).toBe('/local/$import');
  });
});
