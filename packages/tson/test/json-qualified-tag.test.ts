/**
 * [TSON-JSON] §3.3: `$type` holds a type's name as TSON text's `!name` does, a qualified name
 * included -- `"$type": "geo.address"` names the member `address` of the schema map nested as
 * `geo` ([TSON-SCHEMA] §4.1), resolved from the root, and one naming no member is refused as an
 * unresolvable tag is, in both encodings alike. The case set of the Java reference's
 * `JsonQualifiedTagTest`.
 */
import { describe, expect, it } from 'vitest';

import { compile } from '../src/compiler/compile.js';
import type { Diagnostic } from '../src/core/diagnostic.js';
import { validate as validateText } from '../src/facade/tree.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const LINKED = resolveUserSchema(`
!!id:"https://example.test/geo-json.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  geo => !schema {
    address => { street: text }
    point   => { x: int32  y: int32 }
  }
  holder => { at: (geo.address | geo.point)  any: meta.declared }
}
`);
const JSON_SCHEMA = compileJsonSchema(LINKED);
const TEXT_SCHEMA = compile(LINKED);

const fromJson = (body: string): readonly Diagnostic[] =>
  validateJson(body, { schema: JSON_SCHEMA, root: 'holder' }).diagnostics;

const fromTson = (body: string): readonly Diagnostic[] =>
  validateText(new TextEncoder().encode(body), { schema: TEXT_SCHEMA, root: 'holder' }).diagnostics;

describe('§3.3 a $type is a qualified name', () => {
  it('selects a nested member as a variant and as a declared type, in both encodings', () => {
    expect(
      fromJson(
        '{"at": {"$type": "geo.point", "x": 1, "y": 2}, "any": {"$type": "geo.address", "street": "Main"}}',
      ),
    ).toEqual([]);
    expect(
      fromTson('{ at: !geo.point { x: 1  y: 2 }  any: !geo.address { street: Main } }'),
    ).toEqual([]);
  });

  it('naming no member is refused in both, on the same codes', () => {
    const json = fromJson(
      '{"at": {"$type": "geo.point", "x": 1, "y": 2}, "any": {"$type": "geo.region", "street": "Main"}}',
    );
    const tson = fromTson('{ at: !geo.point { x: 1  y: 2 }  any: !geo.region { street: Main } }');
    expect(json.length, 'JSON took a $type naming no member of geo').toBeGreaterThan(0);
    expect(tson.length, 'TSON took a tag naming no member of geo').toBeGreaterThan(0);
    expect(json.map((d) => d.code)).toEqual(tson.map((d) => d.code));
  });
});
