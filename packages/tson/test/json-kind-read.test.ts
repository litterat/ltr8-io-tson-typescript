/**
 * A port of the Java reference's `JsonKindReadTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/JsonKindReadTest.java`): a kind-typed position in
 * JSON ([TSON-SCHEMA] §4.2, [TSON-JSON] §5.6). A kind is an atom whose values are type names, so
 * its JSON form is a string naming a member of the kind in the governing schema's closure, read as
 * the same token in TSON text is. It is never a discrimination case: `kind<uuid_type>` takes
 * `"stock_id"` and refuses a uuid.
 *
 * The reference's `bindModeReadsTheNameIntoText` binds a Java record and has no counterpart here:
 * this package reads JSON in tree mode alone.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA_SOURCE = `
!!id:"https://example.test/json-kinds.tn"
!!meta:"https://tson.io/2026/38/m/meta.tn"
!!import:"https://tson.io/2026/38/m/core.tn"
{
  stock_id    => !uuid_type {}
  customer_id => !uuid_type {}
  sku         => text
  ledger      => { named: kind<uuid_type> }
}
`;

const COMPILED: JsonCompiledSchema = compileJsonSchema(resolveUserSchema(SCHEMA_SOURCE));

function read(json: string): ReturnType<typeof validateJson> {
  return validateJson(json, { schema: COMPILED, root: 'ledger' });
}

function accepted(json: string): string {
  const result = read(json);
  expect(result.diagnostics, 'expected a clean read').toEqual([]);
  if (result.value === undefined) throw new Error('a clean read yielded no value');
  return jsonValueToText(result.value);
}

function refusal(json: string): Diagnostic {
  const { diagnostics } = read(json);
  expect(
    diagnostics,
    `expected exactly one problem, got ${JSON.stringify(diagnostics)}`,
  ).toHaveLength(1);
  const first = diagnostics[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

describe('§5.6 a kind is a string naming a member of the kind', () => {
  it('§5.6: a string naming a member is admitted', () => {
    expect(accepted('{"named": "stock_id"}')).toBe('{"named":"stock_id"}');
    expect(accepted('{"named": "uuid"}')).toBe('{"named":"uuid"}');
  });

  it('§5.6: the name of a type built with another constructor is refused', () => {
    const problem = refusal('{"named": "sku"}');
    expect(problem.code).toBe('ATOM_CONSTRAINT_VIOLATION');
    expect(problem.path).toBe('/named');
    expect(problem.message).toContain('is not a member of this kind');
  });

  it('§5.6: a value of a member is no name', () => {
    expect(refusal('{"named": "7d3e5f8a-1b2c-4d5e-8f90-a1b2c3d4e5f6"}').code).toBe(
      'ATOM_FORM_INVALID',
    );
  });

  /** §5.6: a kind is an atom read from a string, so a tagged object is the wrong JSON kind, not a member. */
  it('§5.6: a tagged value is not a kind’s form', () => {
    expect(
      refusal('{"named": {"$type": "stock_id", "$value": "7d3e5f8a-1b2c-4d5e-8f90-a1b2c3d4e5f6"}}')
        .code,
    ).toBe('TYPE_MISMATCH');
  });
});
