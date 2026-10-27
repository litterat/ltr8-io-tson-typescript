/**
 * [TSON-SCHEMA] §4.1: a value at a position typed by a namespace type is the map its facets
 * describe, never a record of those facets -- read so by the compiled data reader as by the
 * schema resolver. A record's `fields` is its `field_map`, so a field written twice is that map's
 * repeated key ([TSON-DATA] §2.6), reported at the repeat.
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeIdentity } from '../src/link/identity.js';
import { standardLibrary } from '../src/stdlib/index.js';

const META = 'https://tson.io/2026/38/m/meta.tn';

function diagnosticsOf(document: string): readonly { code: string; path?: string }[] {
  const tson = standardLibrary();
  const meta = tson.schemas.get(canonicalizeIdentity(META));
  if (meta === undefined) throw new Error('meta.tn is not registered');
  return tson.validate(new TextEncoder().encode(document), {
    schema: tson.compile(meta),
    root: 'record',
  }).diagnostics;
}

describe('a namespace-typed slot reads as its map (§4.1)', () => {
  it('a record value’s `fields` is a map of names to record fields', () => {
    expect(
      diagnosticsOf('!record { fields: { x => { type: int32 }  y => { type: text } } }'),
    ).toEqual([]);
  });

  it('a field name written twice is the map’s duplicate key, at the repeat', () => {
    const found = diagnosticsOf(
      '!record { fields: { x => { type: int32 }  x => { type: text } } }',
    );
    expect(found.map((d) => [d.code, d.path])).toEqual([['DUPLICATE_MAP_KEY', '/fields/x']]);
  });

  it('the facets are not fields of the value: a record of them is refused', () => {
    const found = diagnosticsOf('!record { fields: { key_type: text  value_type: record_field } }');
    expect(found.length).toBeGreaterThan(0);
  });
});
