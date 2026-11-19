/**
 * A dependent field in JSON ([TSON-SCHEMA] §5.6, [TSON-JSON] §6.1.6): `v?: kind!` is read against
 * the type its sibling `kind` names in the same object. The dependent read itself is not built
 * yet (`json/schema/dependent.ts`), so what these cases hold is the gap's contract: the dependent
 * member reports `NOT_IMPLEMENTED` -- a non-verdict, so an `error` outcome is never mistaken for
 * one -- and consumes its whole value, and every other member of the record reads as usual.
 */
import { describe, expect, it } from 'vitest';

import { isVerdict } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const COMPILED = compileJsonSchema(
  resolveUserSchema(`
!!id:"https://example.test/json-dependent.tn"
!!import:"https://tson.io/2026/39/m/core.tn"
!schema {
  cell      => { kind: meta.type_ref  v?: kind! }
  int_cell  => cell ^ { kind?: = int32 }
  defaulted => { kind?: meta.type_ref ~ int32  v?: kind! }
  rows      => { cells: [cell]  tail: text }
}
`),
);

const diagnosticsOf = (root: string, body: string) =>
  validateJson(body, { schema: COMPILED, root }).diagnostics;

describe('§5.6 a dependent member is a gap, and only the member', () => {
  it('a dependent member reports NOT_IMPLEMENTED at the member, whichever way its sibling is known', () => {
    for (const [root, body] of [
      ['cell', '{"kind": "int32", "v": 5}'],
      ['cell', '{"v": 5, "kind": "int32"}'],
      ['int_cell', '{"v": 7}'],
      ['defaulted', '{"v": 7}'],
    ] as const) {
      const found = diagnosticsOf(root, body);
      expect(
        found.map((d) => [d.code, d.path]),
        body,
      ).toEqual([['NOT_IMPLEMENTED', '/v']]);
      expect(isVerdict('NOT_IMPLEMENTED')).toBe(false);
    }
  });

  it('the member is consumed whole, so the members after it still read', () => {
    const found = diagnosticsOf(
      'rows',
      '{"cells": [{"kind": "int32", "v": {"a": [1, 2]}}], "tail": 3}',
    );
    expect(found.map((d) => [d.code, d.path])).toEqual([
      ['NOT_IMPLEMENTED', '/cells/0/v'],
      ['TYPE_MISMATCH', '/tail'],
    ]);
  });

  it('a record whose dependent member is omitted reads clean', () => {
    expect(diagnosticsOf('cell', '{"kind": "int32"}')).toEqual([]);
    expect(diagnosticsOf('defaulted', '{}')).toEqual([]);
  });

  it('null at the dependent member is the ordinary absence refusal, never the gap', () => {
    const found = diagnosticsOf('cell', '{"kind": "int32", "v": null}');
    expect(found.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
  });
});
