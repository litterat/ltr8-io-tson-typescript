/**
 * A dependent field in JSON ([TSON-SCHEMA] §5.2, [TSON-JSON] §6.1.6): `v?: kind!` is read against
 * the type its sibling `kind` names in the same object -- a pinned sibling's, a defaulted one's, or
 * a free sibling's, which is then written first. A sibling naming no type a value can be read against
 * is refused at the sibling, and a dependent member written without its group-member sibling is
 * refused where it is written.
 */
import { describe, expect, it } from 'vitest';

import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const COMPILED = compileJsonSchema(
  resolveUserSchema(`
!!id:"https://example.test/json-dependent.tn"
!!import:"https://tson.io/2026/40/m/meta.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  point     => { x: int32  y: int32 }
  box       => <T> { item: T }
  cell      => { kind: meta.type_ref  v?: kind! }
  int_cell  => cell ^ { kind?: = int32 }
  defaulted => { kind?: meta.type_ref ~ int32  v?: kind! }
  rows      => { cells: [cell]  tail: text }
  grouped   => { ( kind: meta.type_ref | name: text )  v?: kind! }
}
`),
);

const found = (root: string, body: string) =>
  validateJson(body, { schema: COMPILED, root }).diagnostics.map((d) => [d.code, d.path]);

describe('§5.2 a dependent member is read against the type its sibling names', () => {
  it('a free sibling written first types the member', () => {
    expect(found('cell', '{"kind": "int32", "v": 5}')).toEqual([]);
    expect(found('cell', '{"kind": "point", "v": {"x": 1, "y": 2}}')).toEqual([]);
    expect(found('cell', '{"kind": "point", "v": 5}')).toEqual([['TYPE_MISMATCH', '/v']]);
  });

  it('a pinned or defaulted sibling types an omitted one', () => {
    expect(found('int_cell', '{"v": 7}')).toEqual([]);
    expect(found('int_cell', '{"v": "hello"}')).toEqual([['TYPE_MISMATCH', '/v']]);
    expect(found('defaulted', '{"v": 7}')).toEqual([]);
    expect(found('defaulted', '{"v": "hello"}')).toEqual([['TYPE_MISMATCH', '/v']]);
  });

  it('§6.1.6: only a free sibling orders the members -- a pinned one may follow its dependent member', () => {
    expect(found('int_cell', '{"v": 7, "kind": "int32"}')).toEqual([]);
    expect(found('cell', '{"v": 5, "kind": "int32"}')).toEqual([['VALIDATION_ERROR', '/v']]);
    expect(found('defaulted', '{"v": 5, "kind": "int32"}')).toEqual([['VALIDATION_ERROR', '/v']]);
  });

  it('a dependent member written without its group-member sibling is refused at the member', () => {
    expect(found('grouped', '{"kind": "int32", "v": 5}')).toEqual([]);
    expect(found('grouped', '{"name": "x"}')).toEqual([]);
    expect(found('grouped', '{"name": "x", "v": 5}')).toEqual([['VALIDATION_ERROR', '/v']]);
    expect(found('cell', '{"v": 5}')).toEqual([['FIELD_REQUIRED', '/kind']]);
  });

  it('a sibling naming no type a value can be read against is refused at the sibling', () => {
    // The sibling's own reference read refuses a template or a sibling reference, so the member is
    // skipped unjudged: one refusal, at the sibling.
    for (const body of ['{"kind": "box", "v": {"item": 5}}', '{"kind": "kind!", "v": 5}']) {
      expect(found('cell', body).map(([, path]) => path)).toEqual(['/kind']);
    }
    expect(found('cell', '{"kind": "box"}')).toEqual([]);
  });

  it('the member is consumed whole, so the members after it still read', () => {
    expect(found('rows', '{"cells": [{"kind": "int32", "v": "x"}], "tail": 3}')).toEqual([
      ['TYPE_MISMATCH', '/cells/0/v'],
      ['TYPE_MISMATCH', '/tail'],
    ]);
  });

  it('a record whose dependent member is omitted reads clean', () => {
    expect(found('cell', '{"kind": "int32"}')).toEqual([]);
    expect(found('defaulted', '{}')).toEqual([]);
  });

  it('null at the dependent member is the ordinary absence refusal', () => {
    expect(found('cell', '{"kind": "int32", "v": null}')).toEqual([['FIELD_REQUIRED', '/v']]);
  });
});
