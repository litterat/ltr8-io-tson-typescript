import { describe, expect, it } from 'vitest';

import { mapSchemaSource } from '../src/config.js';
import type { Tson } from '../src/config.js';
import type { Diagnostic, DiagnosticCode } from '../src/core/diagnostic.js';
import { TsonSchemaFetchError, TsonParseError } from '../src/core/errors.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { standardLibrary } from '../src/stdlib/index.js';

/**
 * A reference in a data document ([TSON-SCHEMA] §4.2, §5.12, §8.2, [TSON-DATA] §2.2): a data document is read under
 * the one namespace its own `!!import`s merge into (§2.2.3), a name at a reference slot is judged over that
 * namespace, and an application is judged through the entry the schema closed it to.
 */

const META = '!!import:"https://tson.io/2026/39/m/meta.tn"';
const CORE = '!!import:"https://tson.io/2026/39/m/core.tn"';

const ORDERS = `!!id:"https://example.test/orders.tn"
${META}
${CORE}
!schema {
  order      => { id: text }
  rush_order => order & { by: text }
  customer   => { name: text }
  orders     => !meta.namespace { key_type: meta.identifier  value_type: order }
  order_ref  => meta.ref<order>
  pick       => { which: order_ref }
  o1         => !order { id: "A-1" }
  r1         => !rush_order { id: "R-1"  by: noon }
  c1         => !customer { name: Ada }
  book       => !orders { first => { id: "B-1" } }
  names      => set<text>
  box        => <T> { v: T }
  user_id    => uuid
  uid        => user_id
  boxed      => box<uuid>
  holder     => { t: meta.type_ref  field?: meta.field_type_ref }
}`;

const SHIPPING = `!!id:"https://example.test/shipping.tn"
${META}
${CORE}
!schema {
  parcel => { weight: int32 }
}`;

const CLASHING = `!!id:"https://example.test/clashing.tn"
${META}
${CORE}
!schema {
  parcel => { colour: text }
}`;

function instance(documents: Record<string, string> = {}): Tson {
  const encoded: Record<string, Uint8Array> = {};
  for (const [id, text] of Object.entries(documents)) encoded[id] = encodeUtf8(text);
  return standardLibrary({ schemaSource: mapSchemaSource(encoded) });
}

async function validated(
  tson: Tson,
  imports: readonly string[],
  body: string,
): Promise<readonly Diagnostic[]> {
  await tson.preload(imports);
  const header = imports.map((id) => `!!import:"${id}"\n`).join('');
  return tson.validateDocument(encodeUtf8(header + body)).diagnostics;
}

const ORDERS_ID = 'https://example.test/orders.tn';
const SHIPPING_ID = 'https://example.test/shipping.tn';
const CLASHING_ID = 'https://example.test/clashing.tn';
const ALL = { [ORDERS_ID]: ORDERS, [SHIPPING_ID]: SHIPPING, [CLASHING_ID]: CLASHING };

function codes(diagnostics: readonly Diagnostic[]): DiagnosticCode[] {
  return diagnostics.map((d) => d.code);
}

describe('a name at a reference over a type names a value of it (§4.2, §5.12)', () => {
  it.each([
    ['an entry whose value is of the type', 'o1'],
    ['an entry whose value is of a subtype', 'r1'],
    ['a key of a namespace value', 'book.first'],
  ])('%s is read', async (_label, name) => {
    expect(await validated(instance(ALL), [ORDERS_ID], `!pick { which: ${name} }`)).toEqual([]);
  });

  it.each([
    ['a value of another type', 'c1'],
    ['a type', 'order'],
    ['nothing', 'nope'],
    ['a key the namespace value does not hold', 'book.second'],
    ['a segment that is no identifier', 'book.1x'],
  ])('%s is refused as a constraint the value breaks', async (_label, name) => {
    const found = await validated(instance(ALL), [ORDERS_ID], `!pick { which: ${name} }`);
    expect(codes(found).length).toBeGreaterThan(0);
    for (const code of codes(found)) {
      expect(['ATOM_CONSTRAINT_VIOLATION', 'ATOM_FORM_INVALID']).toContain(code);
    }
  });
});

describe('a name or application at a reference over a constructor names a type (§4.2, §8.2)', () => {
  it('an applied type the schema closed is a member, written unquoted', async () => {
    expect(await validated(instance(ALL), [ORDERS_ID], '!holder { t: set<text> }')).toEqual([]);
  });

  it('an application compares its arguments past their aliases, at every level', async () => {
    const tson = instance(ALL);
    // `uid` reaches `uuid` through `user_id`, so `box<uid>` is `box<uuid>`, which the schema closed as `boxed`.
    expect(await validated(tson, [ORDERS_ID], '!holder { t: box<uid> }')).toEqual([]);
    expect(await validated(tson, [ORDERS_ID], '!holder { t: box<user_id> }')).toEqual([]);
  });

  it('an application nothing in the closure closed names no type and is refused: data never creates one', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!holder { t: box<int32> }');
    expect(codes(found)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('a quoted token is never a reference', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!holder { t: "set<text>" }');
    expect(found.length).toBeGreaterThan(0);
  });

  it('a sibling reference stands only where the reference allows one (allow_sibling, §5.2)', async () => {
    const tson = instance(ALL);
    expect(await validated(tson, [ORDERS_ID], '!holder { t: text  field: kind! }')).toEqual([]);
    const refused = await validated(tson, [ORDERS_ID], '!holder { t: kind! }');
    expect(codes(refused)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
  });

  it('a name that is no member of the kind is refused, naming the kind', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!holder { t: nowhere }');
    expect(codes(found)).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
    expect(found[0]?.message).toContain('is not a member of this kind');
  });
});

describe('a data document reads under the namespace its imports merge into (§2.2.3, [TSON-DATA] §2.2)', () => {
  it('several imports are one namespace over their closures', async () => {
    const tson = instance(ALL);
    expect(await validated(tson, [ORDERS_ID, SHIPPING_ID], '!parcel { weight: 3 }')).toEqual([]);
    // The same set in any spelling is the same namespace, compiled once.
    expect(await validated(tson, [SHIPPING_ID, ORDERS_ID], '!pick { which: o1 }')).toEqual([]);
  });

  it('a name two imports declare differently refuses the whole namespace', async () => {
    const found = await validated(
      instance(ALL),
      [SHIPPING_ID, CLASHING_ID],
      '!parcel { weight: 3 }',
    );
    expect(codes(found)).toEqual(['SCHEMA_ERROR']);
  });

  it('a root type-ref naming no type of the closure is an unknown type', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '!nothing { a: 1 }');
    expect(codes(found)).toEqual(['UNKNOWN_TYPE']);
  });

  it('a qualified root tag walks into a schema map, and finds no member there', async () => {
    const tson = instance({
      'https://example.test/geo.tn': `!!id:"https://example.test/geo.tn"
${META}
${CORE}
!schema {
  geo => !schema {
    address => { street: text }
  }
}`,
    });
    expect(
      await validated(tson, ['https://example.test/geo.tn'], '!geo.address { street: x }'),
    ).toEqual([]);
    expect(
      codes(await validated(tson, ['https://example.test/geo.tn'], '!geo.region { street: x }')),
    ).toEqual(['UNKNOWN_TYPE']);
  });

  it('a document that imports a schema and states no root type-ref has no type to read as', async () => {
    const found = await validated(instance(ALL), [ORDERS_ID], '{ a: 1 }');
    expect(codes(found)).toEqual(['VALIDATION_ERROR']);
  });

  it('an import that is not registered is reported as the schema failing to load, never thrown', () => {
    const tson = instance(ALL);
    const found = tson.validateDocument(
      encodeUtf8(`!!import:"https://example.test/orders.tn"\n!pick { which: o1 }`),
    );
    expect(codes(found.diagnostics)).toEqual(['SCHEMA_ERROR']);
  });

  it('a document with no import has no schema and reads schemaless', () => {
    const found = instance().validateDocument(encodeUtf8('{ a: 1 }'));
    expect(found.diagnostics).toEqual([]);
  });

  it('readDocument throws at the first problem', async () => {
    const tson = instance(ALL);
    await tson.preload([ORDERS_ID]);
    expect(() =>
      tson.readDocument(encodeUtf8(`!!import:"${ORDERS_ID}"\n!pick { which: c1 }`)),
    ).toThrow();
    expect(tson.readDocument(encodeUtf8(`!!import:"${ORDERS_ID}"\n!pick { which: o1 }`)).kind).toBe(
      'record',
    );
  });
});

describe('preload obtains a schema with what it names (§2.2.3)', () => {
  it('a schema’s own imports are fetched and resolved first, in dependency order', async () => {
    const tson = standardLibrary({
      schemaSource: mapSchemaSource({
        'https://example.test/top.tn': encodeUtf8(`!!id:"https://example.test/top.tn"
${META}
!!import:"https://example.test/middle.tn"
!schema { top => { m: middle } }`),
        'https://example.test/middle.tn': encodeUtf8(`!!id:"https://example.test/middle.tn"
${META}
${CORE}
!schema { middle => { n: int32 } }`),
      }),
    });
    await tson.preload(['https://example.test/top.tn']);
    expect(tson.schemas.has('example.test/top.tn')).toBe(true);
    expect(tson.schemas.has('example.test/middle.tn')).toBe(true);
  });

  it('a document that is no schema is refused as an import, by the test that classifies a document', async () => {
    const tson = standardLibrary({
      schemaSource: mapSchemaSource({
        'https://example.test/data.tn': encodeUtf8(
          '!!id:"https://example.test/data.tn"\n{ price: 10 }\n',
        ),
      }),
    });
    await expect(tson.preload(['https://example.test/data.tn'])).rejects.toThrow(TsonParseError);
  });

  it('a schema the source cannot supply is a fetch failure naming it', async () => {
    const tson = standardLibrary({ schemaSource: mapSchemaSource({}) });
    await expect(tson.preload(['https://example.test/missing.tn'])).rejects.toThrow(
      TsonSchemaFetchError,
    );
  });
});
